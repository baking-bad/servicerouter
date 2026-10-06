import { fixtureTime } from '@servicerouter/testing';

import { asc, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret } from '@servicerouter/common';
import { hashApiKey, loadPlatformConfig, type NewPayment } from '@servicerouter/core';
import {
  balances, createAccountRepository, createLedger, createPaymentKeyRepository, createPaymentRepository, createServiceRepository,
  ledgerAccountIds, type Ledger,
} from '@servicerouter/db';
import { createFakeClock, createTestDatabase, type FakeClock, type TestDatabase } from '@servicerouter/testing';

import { createHoldExpiry, HoldExpiryFailedError, holdTtlMs } from '../../src/holdExpiry.js';

const ttlMs = 5 * 60_000;
const logger = createLogger({ level: 'silent' });

let database: TestDatabase;
let clock: FakeClock;
let ledger: Ledger;
let counter = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = createFakeClock(fixtureTime(0, 5, 12, 0, 0, 0));
  ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
});

afterAll(async () => {
  await database?.drop();
});

const newAccount = async (): Promise<string> => {
  counter += 1;
  const id = `acc_${counter}`;
  await createAccountRepository({ db: database.db }).create({ id, email: undefined, createdAt: clock.now() });

  return id;
};

/** A buyer with $1 and a key, and a seller with a live service. */
const setup = async () => {
  const [buyer, seller] = [await newAccount(), await newAccount()];
  counter += 1;
  const keyId = `key_${counter}`;
  await createPaymentKeyRepository({ db: database.db }).insert({
    id: keyId, accountId: buyer, keyHash: hashApiKey(Secret.from(`sr_test_${keyId}`)), label: undefined, createdAt: clock.now(),
    allowance: undefined, dailyBudget: 5_000_000n, maxPrice: undefined, expiresAt: undefined,
  });
  const serviceId = `svc-${counter}`;
  await createServiceRepository({ db: database.db }).createIfMissing({ id: serviceId as never, ownerAccountId: seller, state: 'live', createdAt: clock.now() });
  await ledger.credit({ accountId: buyer, amount: 1_000_000n, reference: `credit-${buyer}` });

  return { buyer, seller, keyId, serviceId };
};

type Setup = Awaited<ReturnType<typeof setup>>;

const hold = async ({ buyer, seller, keyId, serviceId }: Setup, changes: Partial<NewPayment> = {}): Promise<string> => {
  counter += 1;
  const result = await ledger.hold({
    payment: {
      id: `pay_${counter}`, requestId: undefined, kind: 'service', rail: 'credits', buyerAccountId: buyer, keyId, sellerAccountId: seller, serviceId,
      routeKey: 'getWeather', targetHost: undefined, targetPath: undefined, network: undefined, asset: undefined, atomicAmount: undefined,
      amount: 1_000n, ...changes,
    } as NewPayment & { rail: 'credits'; buyerAccountId: string; keyId: string },
    dailyBudget: 5_000_000n,
    allowance: undefined,
  });
  if (!result.ok)
    throw new Error(result.refusal);

  return result.payment.id;
};

const decide = (paymentId: string, decision: 'billable' | 'not_billable') =>
  createPaymentRepository({ db: database.db, clock }).recordDecision({ paymentId, decision, upstreamStatus: decision === 'billable' ? 200 : 500, upstreamLatencyMs: 5 });

const statusOf = async (paymentId: string) => (await createPaymentRepository({ db: database.db, clock }).find(paymentId))?.status;

const balancesOf = async (accountIds: readonly string[]) => {
  const ids = accountIds.flatMap(id => [ledgerAccountIds.available(id), ledgerAccountIds.held(id), ledgerAccountIds.earned(id)]);

  return database.db.select({ id: balances.ledgerAccountId, balance: balances.balance }).from(balances)
    .where(inArray(balances.ledgerAccountId, ids))
    .orderBy(asc(balances.ledgerAccountId));
};

const job = (changes: Partial<Parameters<typeof createHoldExpiry>[0]> = {}) => createHoldExpiry({
  payments: createPaymentRepository({ db: database.db, clock }),
  ledger,
  clock,
  ttlMs,
  feeBps: 250,
  logger,
  ...changes,
});

describe('hold expiry (LG-9, WK-2, WK-3)', () => {
  it('captures a hold left with a billable decision and releases one with no decision, then moves nothing on a second run', async () => {
    const accounts = await setup();
    clock.set(fixtureTime(0, 5, 12, 0, 0, 0));
    const billable = await hold(accounts);
    await decide(billable, 'billable');
    const undecided = await hold(accounts);
    const notBillable = await hold(accounts);
    await decide(notBillable, 'not_billable');
    clock.set(fixtureTime(0, 5, 12, 4, 0, 0));
    const recent = await hold(accounts);
    // The time comes from the Clock port: 5 minutes and 1 second after the first holds
    clock.set(fixtureTime(0, 5, 12, 5, 1, 0));

    const first = await job()();
    const after = await balancesOf([accounts.buyer, accounts.seller]);
    const second = await job()();

    expect(first).toEqual({ captured: 1, released: 2, failed: 0 });
    expect(await Promise.all([billable, undecided, notBillable, recent].map(statusOf))).toEqual(['captured', 'released', 'released', 'held']);
    expect(second).toEqual({ captured: 0, released: 0, failed: 0 });
    expect(await balancesOf([accounts.buyer, accounts.seller])).toEqual(after);
    // The buyer paid one call, and one more is still held; the seller earned the price less 250 bps
    expect(after).toEqual([
      { id: ledgerAccountIds.available(accounts.buyer), balance: 998_000n },
      { id: ledgerAccountIds.held(accounts.buyer), balance: 1_000n },
      { id: ledgerAccountIds.earned(accounts.seller), balance: 975n },
    ].sort((left, right) => left.id < right.id ? -1 : 1));
  });

  it('pages through more holds than one batch', async () => {
    const accounts = await setup();
    clock.set(fixtureTime(0, 4, 8, 0, 0, 0));
    const ids = await Promise.all(Array.from({ length: 5 }, () => hold(accounts)));
    clock.set(fixtureTime(0, 5, 12, 0, 0, 0));

    const result = await job({ batchSize: 2 })();

    expect(result.released).toBeGreaterThanOrEqual(5);
    expect(new Set(await Promise.all(ids.map(statusOf)))).toEqual(new Set(['released']));
  });

  it('finishes every hold it can, then fails the run for one it can\'t, which the next run tries again', async () => {
    const accounts = await setup();
    clock.set(fixtureTime(0, 3, 8, 0, 0, 0));
    // Billable without a seller: a capture can't book it
    const broken = await hold(accounts, { sellerAccountId: undefined, serviceId: undefined });
    await decide(broken, 'billable');
    const fine = await hold(accounts);
    clock.set(fixtureTime(0, 5, 12, 0, 0, 0));

    const error = await job()().catch((thrown: unknown) => thrown);
    const again = await job()().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HoldExpiryFailedError);
    expect((error as HoldExpiryFailedError).result).toMatchObject({ failed: 1 });
    expect(await statusOf(fine)).toBe('released');
    expect(await statusOf(broken)).toBe('held');
    expect((again as HoldExpiryFailedError).result).toEqual({ captured: 0, released: 0, failed: 1 });
    // Done with it: the later tests' runs shouldn't trip over it
    await ledger.release({ paymentId: broken });
  });
});

describe('the hold TTL (LG-9)', () => {
  it('is longer than the proxy\'s total timeout, and at least 5 minutes', async () => {
    const config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });

    expect(holdTtlMs(config)).toBe(5 * 60_000);
    expect(holdTtlMs(config)).toBeGreaterThan(config.timeouts.requestMs);
    expect(holdTtlMs({ timeouts: { ...config.timeouts, requestMs: 400_000 } })).toBe(800_000);
  });
});
