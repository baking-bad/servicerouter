import { fixtureTime } from '@servicerouter/testing';

import { describe, expect, it, vi } from 'vitest';

import { Secret } from '@servicerouter/common';
import { hashApiKey, InvalidKeyError, WrongKeyTypeError, type HoldInput, type HoldRefusal, type Payment, type PaymentKey } from '@servicerouter/core';

import {
  buildPaymentRequired, createCreditsRail, HoldRefusedError, KeyPriceLimitError, type CreditsCredential, type CreditsLedger, type Quote,
} from '../src/index.js';

const keyPrefixes = { master: 'srm_test_', payment: 'sr_test_' };
const paymentKey = `sr_test_${'a'.repeat(43)}`;
const hash = hashApiKey(Secret.from(paymentKey));
const credential: CreditsCredential = { rail: 'credits', key: { kind: 'payment', hash } };

const key = (changes: Partial<PaymentKey> = {}): PaymentKey => ({
  id: 'key_1',
  accountId: 'acc_buyer',
  label: undefined,
  createdAt: new Date(fixtureTime(0, 1, 0, 0, 0, 0)),
  revokedAt: undefined,
  allowance: undefined,
  dailyBudget: 5_000_000n,
  maxPrice: undefined,
  expiresAt: undefined,
  ...changes,
});

const quote: Quote = {
  paymentId: 'pay_1',
  requestId: 'req-1',
  resource: 'https://pay.example.com/service/weather/weather/oslo',
  priceMicroUsd: 1_000n,
  description: 'Current weather',
  subject: { kind: 'service', serviceId: 'weather', routeKey: 'getWeather', sellerAccountId: 'acc_seller' },
  feeBps: 250,
};

// `found: null` is an unknown key
const setup = ({ found = key(), refusal }: { found?: PaymentKey | null; refusal?: HoldRefusal } = {}) => {
  const clock = { now: () => new Date(fixtureTime(0, 5, 12, 0, 0, 0)) };
  const holds: HoldInput[] = [];
  const ledger: CreditsLedger = {
    hold: vi.fn(async (input: HoldInput) => {
      holds.push(input);

      return refusal ? { ok: false as const, refusal } : { ok: true as const, payment: { id: input.payment.id } as Payment };
    }),
    capture: vi.fn(async () => ({ payment: {} as Payment, fee: 25n, sellerAmount: 975n })),
    release: vi.fn(async () => ({ payment: {} as Payment })),
  };
  const findByHash = vi.fn(async () => found ?? undefined);
  const rail = createCreditsRail({
    keys: { findByHash },
    ledger,
    clock,
    keyPrefixes,
    signupUrl: 'https://api.example.com/v1/accounts',
    guideUrl: 'https://example.com/llms.txt',
  });

  return { rail, ledger, holds, findByHash };
};

describe('the credits rail (PR-4)', () => {
  it('holds the price for the key\'s account with its limits, and records what the call is for (LG-6, LG-7)', async () => {
    const { rail, holds } = setup({ found: key({ allowance: 20_000_000n }) });

    const authorization = await rail.authorize(credential, quote);

    expect(holds).toEqual([{
      payment: {
        id: 'pay_1', requestId: 'req-1', kind: 'service', rail: 'credits', buyerAccountId: 'acc_buyer', keyId: 'key_1',
        sellerAccountId: 'acc_seller', serviceId: 'weather', routeKey: 'getWeather', targetHost: undefined, targetPath: undefined,
        network: undefined, asset: undefined, atomicAmount: undefined, amount: 1_000n,
      },
      dailyBudget: 5_000_000n,
      allowance: 20_000_000n,
    }]);
    expect(authorization).toEqual({
      rail: 'credits',
      paymentId: 'pay_1',
      amount: 1_000n,
      feeBps: 250,
      buyer: 'account:acc_buyer',
      receipt: { headers: { 'servicerouter-receipt': 'id="pay_1", amount="0.001", currency="USD"' } },
    });
  });

  it('records a routed call\'s target instead of a service (PR-11)', async () => {
    const { rail, holds } = setup();

    await rail.authorize(credential, { ...quote, subject: { kind: 'routed', targetHost: 'api.target.com', targetPath: '/v1/quote' } });

    expect(holds[0]?.payment).toMatchObject({ kind: 'routed', serviceId: undefined, sellerAccountId: undefined, targetHost: 'api.target.com', targetPath: '/v1/quote' });
  });

  it.each([
    ['a master key, before any lookup (AK-4)', { rail: 'credits', key: { kind: 'master' } }, WrongKeyTypeError],
    ['a malformed key, before any lookup', { rail: 'credits', key: { kind: 'invalid' } }, InvalidKeyError],
  ] as const)('refuses %s', async (_case, refused, error) => {
    const { rail, findByHash, ledger } = setup();

    await expect(rail.authorize(refused, quote)).rejects.toThrow(error);
    expect(findByHash).not.toHaveBeenCalled();
    expect(ledger.hold).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown key', null],
    ['a revoked key', key({ revokedAt: new Date(fixtureTime(0, 4, 0, 0, 0, 0)) })],
    ['an expired key (AK-6)', key({ expiresAt: new Date(fixtureTime(0, 5, 12, 0, 0, 0)) })],
  ])('refuses %s with invalid_key, holding nothing', async (_case, found) => {
    const { rail, ledger } = setup({ found });

    await expect(rail.authorize(credential, quote)).rejects.toThrow(InvalidKeyError);
    expect(ledger.hold).not.toHaveBeenCalled();
  });

  it('refuses a price above the key\'s maximum per call with key_price_limit, holding nothing', async () => {
    const { rail, ledger } = setup({ found: key({ maxPrice: 999n }) });

    await expect(rail.authorize(credential, quote)).rejects.toThrow(KeyPriceLimitError);
    expect(ledger.hold).not.toHaveBeenCalled();
    await expect(setup({ found: key({ maxPrice: 1_000n }) }).rail.authorize(credential, quote)).resolves.toMatchObject({ paymentId: 'pay_1' });
  });

  it.each(['insufficient_balance', 'key_budget_exceeded', 'key_allowance_exceeded'] as const)('turns a refused hold into %s', async refusal => {
    const { rail } = setup({ refusal });

    await expect(rail.authorize(credential, quote)).rejects.toMatchObject({ code: refusal });
    await expect(rail.authorize(credential, quote)).rejects.toBeInstanceOf(HoldRefusedError);
  });

  it('captures with the quote\'s fee on finalize, and releases on abort (PR-10)', async () => {
    const { rail, ledger } = setup();
    const authorization = await rail.authorize(credential, quote);

    const receipt = await rail.finalize(authorization);
    await rail.abort(authorization);

    expect(ledger.capture).toHaveBeenCalledWith({ paymentId: 'pay_1', feeBps: 250 });
    expect(ledger.release).toHaveBeenCalledWith({ paymentId: 'pay_1' });
    expect(receipt).toEqual(authorization.receipt);
  });

  it('puts the price, the signup endpoint, and the guide in its part of the 402 (PR-2)', () => {
    const { rail } = setup();

    expect(buildPaymentRequired([rail], quote)).toEqual({
      status: 402,
      headers: { 'cache-control': 'no-store' },
      body: {
        credits: {
          price: '0.001',
          currency: 'USD',
          authorization: 'Bearer <payment key>',
          signup: { method: 'POST', url: 'https://api.example.com/v1/accounts' },
          guide: 'https://example.com/llms.txt',
        },
      },
    });
  });
});
