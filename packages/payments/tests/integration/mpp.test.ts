import { Challenge, PaymentRequest, Receipt, Store } from 'mppx';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, Secret } from '@servicerouter/common';
import { loadPlatformConfig, type NewPayment, type PlatformConfig, type SettleInput } from '@servicerouter/core';
import {
  createFakeClock, createTestTempoPayer, pathUsdAddress, pushMppCredential, startFakeTempoRpc, tamperMppSignature, type FakeTempoRpc,
  type TestTempoPayer,
} from '@servicerouter/testing';

import {
  createMppRail, createMppSettlementCheck, fromMppSettlementRequest, initializeMpp, mppReceiptGraceMs, PaymentInvalidError,
  PaymentUnavailableError, SettlementFailedError, TempoChainMismatchError, type MppSetup, type PaymentRail, type PaymentRecorder, type Quote,
  type ReplayStore, type SettlementLedger,
} from '../../src/index.js';

const recipient = '0x2222222222222222222222222222222222222222';
const otherRecipient = '0x3333333333333333333333333333333333333333';
const secretKey = 'mpp-test-secret-key-of-32-bytes!';
const logger = createLogger({ level: 'silent' });
const timeouts = { connectMs: 1_000, settleMs: 1_000 };

let rpc: FakeTempoRpc;
let payer: TestTempoPayer;
let config: PlatformConfig;
let store: ReplayStore;
let setup: MppSetup;

const load = () => loadPlatformConfig({
  env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from(JSON.stringify({ timeouts })).toString('base64') },
});

// The example config with the Tempo asset changed, such as its minimum price or the recipient
const withTempo = (base: PlatformConfig, change: { readonly minPrice?: bigint; readonly recipient?: string }): PlatformConfig => ({
  ...base,
  assets: base.assets.map(asset => asset.name === 'tempo-pathusd'
    ? { ...asset, ...(change.minPrice === undefined ? {} : { minPrice: change.minPrice }), ...(change.recipient ? { payTo: change.recipient } : {}) }
    : asset),
  mpp: { ...base.mpp, ...(change.recipient ? { recipient: change.recipient } : {}) },
});

const initialize = (options: { readonly config?: PlatformConfig; readonly key?: string; readonly replay?: ReplayStore } = {}) => initializeMpp({
  config: options.config ?? config,
  secretKey: Secret.from(options.key ?? secretKey),
  store: options.replay ?? store,
  timeoutMs: 2_000,
  rpcUrl: rpc.url,
});

beforeAll(async () => {
  rpc = await startFakeTempoRpc({ timeoutMs: 2_000 });
  payer = createTestTempoPayer({ rpcUrl: rpc.url });
  config = await load();
});

afterAll(async () => {
  await rpc?.close();
});

beforeEach(async () => {
  rpc.reset();
  store = Store.memory();
  setup = await initialize();
});

// In-memory ports: what the rail records and books
const createPorts = (railSetup: MppSetup = setup) => {
  const created: (NewPayment & { status: string; transactionHash?: string })[] = [];
  const changes: Record<string, unknown>[] = [];
  const settled: SettleInput[] = [];
  const recorder = {
    create: async (payment: NewPayment & { status: string }) => {
      created.push(payment);

      return payment;
    },
    changeStatus: async (change: Record<string, unknown>) => {
      changes.push(change);

      return change;
    },
  } as unknown as PaymentRecorder;
  const ledger: SettlementLedger = {
    settle: async input => {
      settled.push(input);

      return { payment: {} as never, fee: 0n, sellerAmount: 0n };
    },
  };

  return { created, changes, settled, rail: createMppRail({ setup: railSetup, recorder, ledger, logger, clock: { now: () => new Date() }, settleTimeoutMs: timeouts.settleMs }) };
};

let counter = 0;
const quoteOf = (price = 1_000n, resource = 'https://pay.staging.servicerouter.ai/service/weather/weather/oslo'): Quote => {
  counter += 1;

  return {
    paymentId: `pay_mpp_${counter}`,
    requestId: `req-${counter}`,
    resource,
    priceMicroUsd: price,
    description: 'Current weather',
    subject: { kind: 'service', serviceId: 'weather', routeKey: 'getWeather', sellerAccountId: 'acc_seller' },
    feeBps: 250,
  };
};

// The 402 as a client sees it, from the rail's part of it
const challengeResponse = async (rail: PaymentRail, quote: Quote): Promise<Response> =>
  new Response(null, { status: 402, headers: (await rail.challenge(quote))!.headers });

const credentialOf = (rail: PaymentRail, header: string) => rail.detect({ authorization: header })!;

/** A credential `mppx`'s client signs for the rail's 402 for `quote`. */
const pay = async (rail: PaymentRail, quote: Quote): Promise<string> => payer.credentialFor(await challengeResponse(rail, quote));

describe('the MPP challenge (PR-2, PR-3, PR-9, PX-10)', () => {
  it('offers a Tempo charge in pathUSD on Moderato: the price, pull mode only, and the recipient, bound to the canonical pay URL', async () => {
    const { rail } = createPorts();
    const quote = quoteOf(1_234n);

    const part = await rail.challenge(quote);

    expect(part?.body).toBeUndefined();
    const challenges = Challenge.deserializeList(part!.headers!['www-authenticate']!);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject({
      method: 'tempo',
      intent: 'charge',
      realm: 'pay.staging.servicerouter.ai',
      description: 'Current weather',
      request: { amount: '1234', currency: pathUsdAddress, recipient, methodDetails: { chainId: 42_431, supportedModes: ['pull'] } },
    });
    // The URL the credential is bound to, in the HMAC-bound opaque field
    expect(PaymentRequest.deserialize(challenges[0]!.opaque!)).toEqual({ _mppx_scope: quote.resource });
    expect(Date.parse(challenges[0]!.expires!)).toBeGreaterThan(Date.now());
    expect(challenges[0]!.request['methodDetails']).not.toHaveProperty('feePayer');
  });

  it('offers no Tempo option below the asset\'s minimum price (PR-3)', async () => {
    const { rail } = createPorts(await initialize({ config: withTempo(config, { minPrice: 10_000n }) }));

    expect(await rail.challenge(quoteOf(9_999n))).toBeUndefined();
    expect(Challenge.deserializeList((await rail.challenge(quoteOf(10_000n)))!.headers!['www-authenticate']!)[0]!.request).toMatchObject({ amount: '10000' });
  });
});

describe('MPP payments (PR-9, PR-10, PR-12)', () => {
  it('validates a credential signed by mppx\'s client before forwarding, recording it verified with its transaction hash and moving nothing', async () => {
    const { rail, created } = createPorts();
    const quote = quoteOf();

    const authorization = await rail.authorize(credentialOf(rail, await pay(rail, quote)), quote);

    expect(created).toEqual([expect.objectContaining({
      id: quote.paymentId, rail: 'mpp', status: 'verified', network: 'eip155:42431', asset: pathUsdAddress, atomicAmount: 1_000n, amount: 1_000n,
      sellerAccountId: 'acc_seller', serviceId: 'weather', transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    })]);
    expect(authorization).toMatchObject({ rail: 'mpp', buyer: `address:eip155:42431:${payer.address.toLowerCase()}`, receipt: undefined });
    expect(rpc.rawTransactions).toEqual([]);
    expect(rpc.calls.filter(call => call.method === 'eth_call')).toHaveLength(1);
    expect(JSON.stringify(authorization, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)).not.toContain('Payment ');
  });

  it('broadcasts after a billable answer, waits for the receipt, and books it, with Payment-Receipt and private cache control', async () => {
    const { rail, created, settled } = createPorts();
    const quote = quoteOf();
    const authorization = await rail.authorize(credentialOf(rail, await pay(rail, quote)), quote);

    const receipt = await rail.finalize(authorization);

    expect(rpc.rawTransactions).toHaveLength(1);
    const hash = created[0]!.transactionHash;
    expect(rpc.transactions).toEqual([hash]);
    expect(receipt.headers['cache-control']).toBe('private');
    expect(Receipt.deserialize(receipt.headers['payment-receipt']!)).toMatchObject({ method: 'tempo', status: 'success', reference: hash });
    expect(settled).toEqual([{ paymentId: quote.paymentId, feeBps: 250, asset: 'tempo-pathusd', transactionHash: hash, receipt: receipt.headers['payment-receipt'], needsReview: false }]);
    expect(rpc.unknownMethods).toEqual([]);
  });

  it('cancels after an answer that isn\'t billable: the transaction is never broadcast', async () => {
    const { rail, changes, settled } = createPorts();
    const quote = quoteOf();
    const authorization = await rail.authorize(credentialOf(rail, await pay(rail, quote)), quote);

    await rail.abort(authorization);

    expect(changes).toEqual([{ paymentId: quote.paymentId, to: 'cancelled' }]);
    expect(rpc.rawTransactions).toEqual([]);
    expect(settled).toEqual([]);
  });

  it('refuses a credential used before, on another replica sharing the replay store, before the upstream is called', async () => {
    const first = createPorts();
    const second = createPorts(await initialize());
    const quote = quoteOf();
    const header = await pay(first.rail, quote);

    await first.rail.authorize(credentialOf(first.rail, header), quote);
    const replayed = second.rail.authorize(credentialOf(second.rail, header), { ...quote, paymentId: 'pay_mpp_replayed' });

    await expect(replayed).rejects.toThrow(PaymentInvalidError);
    await expect(replayed).rejects.toThrow('already used');
    expect(second.created).toEqual([]);
  });

  it('refuses a replay after the broadcast too: nothing is broadcast twice', async () => {
    const { rail } = createPorts();
    const quote = quoteOf();
    const header = await pay(rail, quote);
    await rail.finalize(await rail.authorize(credentialOf(rail, header), quote));

    await expect(rail.authorize(credentialOf(rail, header), { ...quote, paymentId: 'pay_mpp_again' })).rejects.toThrow(PaymentInvalidError);
    expect(rpc.rawTransactions).toHaveLength(1);
  });

  it.each([
    ['a push credential: a transaction the buyer broadcast itself', async (rail: PaymentRail, quote: Quote) => pushMppCredential(await challengeResponse(rail, quote), payer.address)],
    ['a credential for another amount', async (rail: PaymentRail) => pay(rail, quoteOf(2_000n))],
    ['a credential for another resource', async (rail: PaymentRail) => pay(rail, quoteOf(1_000n, 'https://pay.staging.servicerouter.ai/service/weather/weather/bergen'))],
    ['a credential with a bad signature', async (rail: PaymentRail, quote: Quote) => tamperMppSignature(await pay(rail, quote))],
    ['a credential for another recipient', async (_rail: PaymentRail, quote: Quote) => pay(createPorts(await initialize({ config: withTempo(config, { recipient: otherRecipient }) })).rail, quote)],
    ['a credential from a challenge another server issued', async (_rail: PaymentRail, quote: Quote) => pay(createPorts(await initialize({ key: 'another-secret-key-of-32-bytes!!' })).rail, quote)],
    ['a header that isn\'t an MPP credential', async () => 'Payment not-base64-json'],
  ])('refuses %s with payment_invalid, before the upstream and without a payment row', async (_case, credential) => {
    const { rail, created } = createPorts();
    const quote = quoteOf();

    await expect(rail.authorize(credentialOf(rail, await credential(rail, quote)), quote)).rejects.toThrow(PaymentInvalidError);
    expect(created).toEqual([]);
    expect(rpc.rawTransactions).toEqual([]);
  });

  it('refuses a transaction the node\'s simulation reverts, such as for an insufficient balance', async () => {
    const { rail, created } = createPorts();
    const quote = quoteOf();
    const header = await pay(rail, quote);
    rpc.simulate('revert');

    await expect(rail.authorize(credentialOf(rail, header), quote)).rejects.toThrow(PaymentInvalidError);
    expect(created).toEqual([]);
  });

  it('answers payment_unavailable while the Tempo RPC doesn\'t answer the check: nothing was paid', async () => {
    const { rail, created } = createPorts();
    const quote = quoteOf();
    const header = await pay(rail, quote);
    rpc.unavailable(true);

    await expect(rail.authorize(credentialOf(rail, header), quote)).rejects.toThrow(PaymentUnavailableError);
    expect(created).toEqual([]);
  });

  it.each([
    ['reverted', 'revert'],
    ['refused by the node', 'refuse'],
  ] as const)('marks a broadcast %s failed and books nothing (PR-12)', async (_case, outcome) => {
    const { rail, changes, settled } = createPorts();
    const quote = quoteOf();
    const authorization = await rail.authorize(credentialOf(rail, await pay(rail, quote)), quote);
    rpc.broadcast(outcome);

    await expect(rail.finalize(authorization)).rejects.toThrow(SettlementFailedError);
    expect(changes).toEqual([{ paymentId: quote.paymentId, to: 'failed' }]);
    expect(settled).toEqual([]);
  });

  it.each([
    ['times out', 'timeout'],
    ['fails at the RPC', 'fail'],
  ] as const)('records a broadcast that %s as settling with its hash, for the follow-up (PR-12, WK-6)', async (_case, outcome) => {
    const { rail, created, changes, settled } = createPorts();
    const quote = quoteOf();
    const authorization = await rail.authorize(credentialOf(rail, await pay(rail, quote)), quote);
    rpc.broadcast(outcome);

    await expect(rail.finalize(authorization)).rejects.toThrow(SettlementFailedError);
    const hash = created[0]!.transactionHash;
    expect(changes).toEqual([{ paymentId: quote.paymentId, to: 'settling', transactionHash: hash, settlementRequest: expect.objectContaining({ rail: 'mpp', transactionHash: hash }) }]);
    expect(fromMppSettlementRequest(changes[0]!['settlementRequest'] as never)).toMatchObject({
      currency: pathUsdAddress, recipient, sender: payer.address.toLowerCase(), amount: '1000', validBefore: expect.any(Number),
    });
    expect(settled).toEqual([]);
  });
});

describe('MPP at startup (PR-9, PR-6)', () => {
  it('stops when the Tempo RPC answers another chain ID than mpp.network', async () => {
    rpc.answerChainId(4_217);

    await expect(initialize()).rejects.toThrow(TempoChainMismatchError);
  });

  it('stops when the Tempo RPC doesn\'t answer', async () => {
    await expect(initializeMpp({ config, secretKey: Secret.from(secretKey), store, timeoutMs: 500, rpcUrl: 'http://127.0.0.1:1' })).rejects.toThrow();
  });

  it('stops when MPP is on without an asset on mpp.network', async () => {
    await expect(initialize({ config: { ...config, assets: config.assets.filter(asset => asset.name !== 'tempo-pathusd') } }))
      .rejects.toThrow('no asset is on mpp.network');
  });

  it('refuses a secret key shorter than 32 bytes', async () => {
    await expect(initialize({ key: 'short' })).rejects.toThrow('at least 32 bytes');
  });
});

describe('the MPP settlement check (WK-6)', () => {
  // A payment whose broadcast timed out: the settlement request the follow-up reads
  const settlingRequest = async () => {
    const { rail, changes } = createPorts();
    const quote = quoteOf();
    const authorization = await rail.authorize(credentialOf(rail, await pay(rail, quote)), quote);
    rpc.broadcast('timeout');
    await expect(rail.finalize(authorization)).rejects.toThrow(SettlementFailedError);
    rpc.reset();

    return fromMppSettlementRequest(changes[0]!['settlementRequest'] as never)!;
  };

  it('settles once the receipt shows the expected transfer, and fails a reverted one', async () => {
    const clock = createFakeClock();
    const check = createMppSettlementCheck({ rpc: setup.rpc, timeoutMs: 1_000, clock });
    const succeeded = await settlingRequest();
    const reverted = await settlingRequest();

    rpc.include(succeeded.transactionHash);
    rpc.include(reverted.transactionHash, 'reverted');

    const settled = await check(succeeded);
    expect(settled).toEqual({ status: 'settled', receipt: expect.any(String) });
    expect(settled.status === 'settled' && Receipt.deserialize(settled.receipt)).toMatchObject({
      method: 'tempo', status: 'success', reference: succeeded.transactionHash, timestamp: clock.now().toISOString(),
    });
    expect(await check(reverted)).toEqual({ status: 'failed', reason: 'reverted' });
    expect(await check({ ...succeeded, amount: '999' })).toEqual({ status: 'failed', reason: 'no_transfer' });
  });

  it('waits for a transaction not found within its validity window, and fails it once the window has passed', async () => {
    const request = await settlingRequest();
    const clock = createFakeClock(new Date(request.validBefore * 1_000));
    const check = createMppSettlementCheck({ rpc: setup.rpc, timeoutMs: 1_000, clock });

    expect(await check(request)).toEqual({ status: 'pending' });
    clock.advance(mppReceiptGraceMs + 1_000);
    expect(await check(request)).toEqual({ status: 'failed', reason: 'expired' });
  });

  it('throws while the RPC doesn\'t answer, so the run tries again', async () => {
    const request = await settlingRequest();
    const check = createMppSettlementCheck({ rpc: setup.rpc, timeoutMs: 1_000, clock: createFakeClock() });
    rpc.unavailable(true);

    await expect(check(request)).rejects.toThrow();
  });
});
