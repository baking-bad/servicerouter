import { fixtureTime } from '@servicerouter/testing';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator } from '@servicerouter/common';
import { loadPlatformConfig, type JsonObject, type PlatformConfig } from '@servicerouter/core';
import { createAccountRepository, createLedger, createPaymentRepository, createServiceRepository } from '@servicerouter/db';
import { createAssetLookup, createFacilitatorLookup, createFacilitators } from '@servicerouter/payments';
import { createFakeClock, createTestDatabase, facilitatorAnswers, startFakeFacilitator, type FakeFacilitator, type TestDatabase } from '@servicerouter/testing';

import { createSettlementFollowUp, SettlementFollowUpError } from '../../src/settlementFollowUp.js';

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const clock = createFakeClock(fixtureTime(0, 5, 12, 0, 0, 0));

let database: TestDatabase;
let facilitator: FakeFacilitator;
let config: PlatformConfig;
let counter = 0;

beforeAll(async () => {
  [database, facilitator] = await Promise.all([createTestDatabase(), startFakeFacilitator({ networks: [base, solana] })]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        feeBps: 250,
        facilitators: [
          { name: 'cdp', url: facilitator.url, networks: [base, solana] },
          { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:preprod'], enabled: false },
        ],
      })).toString('base64'),
    },
  });
});

afterAll(async () => {
  await facilitator?.close();
  await database?.drop();
});

beforeEach(() => {
  facilitator.reset();
});

const payments = () => createPaymentRepository({ db: database.db, clock });

/** A settling x402 payment, as the proxy leaves it. `receipt` says whether the buyer got the response. */
const settling = async ({ receipt, request = true }: { receipt?: string; request?: boolean } = {}): Promise<string> => {
  counter += 1;
  const seller = `acc_seller_${counter}`;
  await createAccountRepository({ db: database.db }).create({ id: seller, email: undefined, createdAt: clock.now() });
  await createServiceRepository({ db: database.db }).createIfMissing({ id: `svc-${counter}` as never, ownerAccountId: seller, state: 'live', createdAt: clock.now() });
  const id = `pay_settling_${counter}`;
  await payments().create({
    id, requestId: undefined, kind: 'service', rail: 'x402', buyerAccountId: undefined, keyId: undefined, sellerAccountId: seller,
    serviceId: `svc-${counter}`, routeKey: 'getWeather', targetHost: undefined, targetPath: undefined, network: base,
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', atomicAmount: 1_000n, amount: 1_000n, status: 'verified',
  });
  const settlementRequest = { paymentPayload: { x402Version: 2, accepted: { network: base }, payload: { authorization: { from: '0xbuyer' } } }, paymentRequirements: { network: base } } as unknown as JsonObject;
  await payments().changeStatus({ paymentId: id, to: 'settling', ...(receipt ? { receipt, transactionHash: '0xbroadcast' } : {}), ...(request ? { settlementRequest } : {}) });

  return id;
};

const followUp = (facilitatorFor = createFacilitatorLookup(config, createFacilitators({ config, cdpApiKey: () => { throw new Error('none'); }, clock }))) => createSettlementFollowUp({
  payments: payments(),
  ledger: createLedger({ db: database.db, clock, ids: randomIdGenerator }),
  facilitatorFor,
  assetName: createAssetLookup(config),
  feeBps: config.feeBps,
  logger: createLogger({ level: 'silent' }),
})();

const statusOf = async (id: string) => (await payments().find(id))?.status;

describe('settlement follow-up (WK-6, PR-12)', () => {
  it('repeats the identical settle, books a settled payment, and flags it for review only when the buyer got no response', async () => {
    const answered = await settling({ receipt: 'eyJzdWNjZXNzIjpmYWxzZX0=' });
    const unanswered = await settling();
    const before = facilitator.requests.length;

    const result = await followUp();

    expect(result).toMatchObject({ settled: 2 });
    expect(await payments().find(answered)).toMatchObject({ status: 'settled', needsReview: false, receipt: 'eyJzdWNjZXNzIjpmYWxzZX0=', fee: 25n });
    expect(await payments().find(unanswered)).toMatchObject({ status: 'settled', needsReview: true, transactionHash: expect.any(String) });
    expect(facilitator.requests.slice(before).map(request => request.body)).toEqual([
      expect.objectContaining({ x402Version: 2, paymentPayload: expect.objectContaining({ x402Version: 2 }), paymentRequirements: { network: base } }),
      expect.objectContaining({ x402Version: 2 }),
    ]);
    // Final: nothing left to repeat (WK-2)
    expect(await followUp()).toEqual({ settled: 0, failed: 0, pending: 0, unknown: 0, skipped: 0 });
  });

  it('leaves a payment still pending for the next run, and marks one that failed for good as failed', async () => {
    const pending = await settling({ receipt: 'eyJ9' });
    facilitator.handle('/settle', facilitatorAnswers.pending('0xstill'));

    const first = await followUp();
    facilitator.handle('/settle', facilitatorAnswers.failed('invalid_exact_evm_payload_authorization_valid_before'));
    const second = await followUp();

    expect(first).toMatchObject({ pending: 1, settled: 0 });
    expect(second).toMatchObject({ failed: 1 });
    expect(await statusOf(pending)).toBe('failed');
  });

  it('fails the run when the facilitator doesn\'t answer, keeping the payment settling for the next one', async () => {
    const waiting = await settling();
    facilitator.handle('/settle', facilitatorAnswers.unavailable);

    const error = await followUp().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SettlementFollowUpError);
    expect((error as SettlementFollowUpError).result).toMatchObject({ unknown: 1 });
    expect(await statusOf(waiting)).toBe('settling');
    facilitator.reset();
    await followUp();
    expect(await statusOf(waiting)).toBe('settled');
  });

  it('skips a payment it can\'t repeat, and fails the run so it gets looked at', async () => {
    const orphan = await settling({ request: false });

    const error = await followUp().catch((thrown: unknown) => thrown);

    expect((error as SettlementFollowUpError).result).toMatchObject({ skipped: 1 });
    expect(await statusOf(orphan)).toBe('settling');
    await payments().changeStatus({ paymentId: orphan, to: 'failed' });
  });
});
