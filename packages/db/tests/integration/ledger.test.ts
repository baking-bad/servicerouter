import { fixtureDay, fixtureTime } from '@servicerouter/testing';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { randomIdGenerator, Secret } from '@servicerouter/common';
import {
  CreditReferenceConflictError, hashApiKey, InvalidPaymentStatusChangeError, PaymentFinalizedError, type HoldInput, type NewPayment,
  type PaymentStatus,
} from '@servicerouter/core';
import { createFakeClock, createTestDatabase, type FakeClock, type TestDatabase } from '@servicerouter/testing';

import {
  balances, createAccountRepository, createLedger, createPaymentKeyRepository, createPaymentRepository, createRoutingRepository, createServiceRepository,
  ledgerAccountIds, type Ledger,
} from '../../src/index.js';

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

const usd = (value: string) => BigInt(Math.round(Number(value) * 1_000_000));

const newAccount = async (): Promise<string> => {
  counter += 1;
  const id = `acc_${counter}`;
  await createAccountRepository({ db: database.db }).create({ id, email: undefined, createdAt: clock.now() });

  return id;
};

const newKey = async (accountId: string, limits: { dailyBudget?: bigint; allowance?: bigint } = {}): Promise<string> => {
  counter += 1;
  const id = `key_${counter}`;
  await createPaymentKeyRepository({ db: database.db }).insert({
    id,
    accountId,
    keyHash: hashApiKey(Secret.from(`sr_test_${id}`)),
    label: undefined,
    createdAt: clock.now(),
    allowance: limits.allowance,
    dailyBudget: limits.dailyBudget ?? usd('5'),
    maxPrice: undefined,
    expiresAt: undefined,
  });

  return id;
};

const newService = async (ownerAccountId: string): Promise<string> => {
  counter += 1;
  const id = `svc-${counter}`;
  await createServiceRepository({ db: database.db }).createIfMissing({ id: id as never, ownerAccountId, state: 'live', createdAt: clock.now() });

  return id;
};

interface Buyer {
  readonly accountId: string;
  readonly keyId: string;
}

const newBuyer = async (credit: string, limits: { dailyBudget?: string; allowance?: string } = {}): Promise<Buyer> => {
  const accountId = await newAccount();
  const keyId = await newKey(accountId, {
    ...(limits.dailyBudget === undefined ? {} : { dailyBudget: usd(limits.dailyBudget) }),
    ...(limits.allowance === undefined ? {} : { allowance: usd(limits.allowance) }),
  });
  if (credit !== '0')
    await ledger.credit({ accountId, amount: usd(credit), reference: `credit-${accountId}` });

  return { accountId, keyId };
};

const payment = (buyer: Buyer, amount: bigint, changes: Partial<NewPayment> = {}): HoldInput['payment'] => {
  counter += 1;

  return {
    id: `pay_${counter}`,
    requestId: `req-${counter}`,
    kind: 'service',
    rail: 'credits',
    buyerAccountId: buyer.accountId,
    keyId: buyer.keyId,
    sellerAccountId: undefined,
    serviceId: undefined,
    routeKey: undefined,
    targetHost: undefined,
    targetPath: undefined,
    network: undefined,
    asset: undefined,
    atomicAmount: undefined,
    amount,
    ...changes,
  } as HoldInput['payment'];
};

const hold = (buyer: Buyer, amount: bigint, limits: { dailyBudget?: string; allowance?: string } = {}, changes: Partial<NewPayment> = {}) => ledger.hold({
  payment: payment(buyer, amount, changes),
  dailyBudget: usd(limits.dailyBudget ?? '5'),
  allowance: limits.allowance === undefined ? undefined : usd(limits.allowance),
});

const unbalancedTransactions = async () => (await database.db.execute(sql`
  select transaction_id, sum(amount)::text as total from ledger_entries group by transaction_id having sum(amount) <> 0
`)).rows;

const negativeBalances = async () => (await database.db.execute(sql`
  select ledger_account_id from balances where balance < 0 and not may_go_negative
`)).rows;

const thrown = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  }
  catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
};

describe('admin credits (LG-2, LG-3)', () => {
  it('moves money from deposits clearing to the buyer\'s available credits, once per reference', async () => {
    const accountId = await newAccount();

    const first = await ledger.credit({ accountId, amount: usd('10'), reference: `ref-${accountId}` });
    const again = await ledger.credit({ accountId, amount: usd('10'), reference: `ref-${accountId}` });

    expect(first.replayed).toBe(false);
    expect(again).toEqual({ ...first, replayed: true });
    expect(await ledger.balance(accountId)).toEqual({ available: usd('10'), held: 0n });
  });

  it('refuses a reference reused for another amount or account', async () => {
    const [accountId, other] = [await newAccount(), await newAccount()];
    await ledger.credit({ accountId, amount: usd('1'), reference: `shared-${accountId}` });

    expect(await thrown(ledger.credit({ accountId, amount: usd('2'), reference: `shared-${accountId}` }))).toBeInstanceOf(CreditReferenceConflictError);
    expect(await thrown(ledger.credit({ accountId: other, amount: usd('1'), reference: `shared-${accountId}` }))).toBeInstanceOf(CreditReferenceConflictError);
    expect(await ledger.balance(accountId)).toEqual({ available: usd('1'), held: 0n });
    expect(await ledger.balance(other)).toEqual({ available: 0n, held: 0n });
  });
});

describe('holds (LG-6, AK-7)', () => {
  it('moves the price from available to held, counts it on the key, and records the payment as held, in one transaction (PR-10)', async () => {
    const buyer = await newBuyer('1');

    const result = await hold(buyer, usd('0.25'));

    expect(result).toMatchObject({ ok: true, payment: { status: 'held', amount: usd('0.25'), keyId: buyer.keyId, buyerAccountId: buyer.accountId } });
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('0.75'), held: usd('0.25') });
    expect(await ledger.keySpend([buyer.keyId], fixtureDay(0, 5))).toEqual(new Map([[buyer.keyId, { today: usd('0.25'), total: usd('0.25') }]]));
  });

  it.each([
    ['the balance', '0.10', {}, 'insufficient_balance'],
    ['the daily budget', '10', { dailyBudget: '0.10' }, 'key_budget_exceeded'],
    ['the allowance', '10', { allowance: '0.10' }, 'key_allowance_exceeded'],
  ] as const)('refuses a hold over %s, and moves nothing', async (_case, credit, limits, refusal) => {
    const buyer = await newBuyer(credit, limits);

    const result = await hold(buyer, usd('0.25'), limits);

    expect(result).toEqual({ ok: false, refusal });
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd(credit), held: 0n });
    expect(await ledger.keySpend([buyer.keyId], fixtureDay(0, 5))).toEqual(new Map());
    expect(await createPaymentRepository({ db: database.db, clock }).listForBuyer({ buyerAccountId: buyer.accountId, limit: 10 })).toEqual({ payments: [], next: undefined });
  });

  it('refuses an account that was never credited as short of funds', async () => {
    expect(await hold(await newBuyer('0'), 1n)).toEqual({ ok: false, refusal: 'insufficient_balance' });
  });

  it('returns the first hold when the same payment is held again (LG-3)', async () => {
    const buyer = await newBuyer('1');
    const input = { payment: payment(buyer, usd('0.25')), dailyBudget: usd('5'), allowance: undefined };

    const first = await ledger.hold(input);
    const again = await ledger.hold(input);

    expect(again).toEqual(first);
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('0.75'), held: usd('0.25') });
  });

  it.each([
    ['the balance', { credit: '3', limits: {} }, 30],
    ['the daily budget', { credit: '10', limits: { dailyBudget: '2.5' } }, 25],
    ['the allowance', { credit: '10', limits: { dailyBudget: '10', allowance: '2' } }, 20],
  ] as const)('never passes %s with 50 concurrent holds (step 4, LG-6, AK-7)', async (_case, { credit, limits }, fits) => {
    const buyer = await newBuyer(credit, limits);

    const results = await Promise.all(Array.from({ length: 50 }, () => hold(buyer, usd('0.10'), limits)));

    const accepted = results.filter(result => result.ok).length;
    expect(accepted).toBe(fits);
    const { available, held } = await ledger.balance(buyer.accountId);
    expect(held).toBe(usd('0.10') * BigInt(accepted));
    expect(available + held).toBe(usd(credit));
    const spend = (await ledger.keySpend([buyer.keyId], fixtureDay(0, 5))).get(buyer.keyId)!;
    expect(spend).toEqual({ today: held, total: held });
    expect(await negativeBalances()).toEqual([]);
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it('starts each key\'s daily budget again at midnight UTC (AR5)', async () => {
    const buyer = await newBuyer('10', { dailyBudget: '0.20' });
    clock.set(fixtureTime(0, 5, 23, 59, 59, 0));
    const late = await hold(buyer, usd('0.20'), { dailyBudget: '0.20' });
    const over = await hold(buyer, usd('0.10'), { dailyBudget: '0.20' });

    clock.set(fixtureTime(0, 6, 0, 0, 0, 0));
    const nextDay = await hold(buyer, usd('0.20'), { dailyBudget: '0.20' });
    // A release gives the spend back to the day it was counted on
    await ledger.release({ paymentId: late.ok ? late.payment.id : '' });

    expect([late.ok, over.ok, nextDay.ok]).toEqual([true, false, true]);
    expect(await ledger.keySpend([buyer.keyId], fixtureDay(0, 5))).toEqual(new Map([[buyer.keyId, { today: 0n, total: usd('0.20') }]]));
    expect(await ledger.keySpend([buyer.keyId], fixtureDay(0, 6))).toEqual(new Map([[buyer.keyId, { today: usd('0.20'), total: usd('0.20') }]]));
    clock.set(fixtureTime(0, 5, 12, 0, 0, 0));
  });
});

describe('capture and release (LG-3, LG-4)', () => {
  const heldPayment = async (amount = usd('0.001')) => {
    const buyer = await newBuyer('1');
    const seller = await newAccount();
    const serviceId = await newService(seller);
    const result = await hold(buyer, amount, {}, { sellerAccountId: seller, serviceId, routeKey: 'getWeather' });
    if (!result.ok)
      throw new Error(result.refusal);

    return { buyer, seller, serviceId, paymentId: result.payment.id };
  };

  it('splits $0.001 at 250 bps into 975 micro-USD for the seller and 25 for the platform (LG-4, AR6)', async () => {
    const { buyer, seller, paymentId } = await heldPayment();
    const [feesBefore] = await database.db.select().from(balances).where(sql`${balances.ledgerAccountId} = ${ledgerAccountIds.fees}`);

    const result = await ledger.capture({ paymentId, feeBps: 250 });

    expect(result).toMatchObject({ fee: 25n, sellerAmount: 975n, payment: { status: 'captured', fee: 25n } });
    const [earned, fees] = await Promise.all([
      database.db.select().from(balances).where(sql`${balances.ledgerAccountId} = ${ledgerAccountIds.earned(seller)}`),
      database.db.select().from(balances).where(sql`${balances.ledgerAccountId} = ${ledgerAccountIds.fees}`),
    ]);
    expect(earned[0]?.balance).toBe(975n);
    expect(fees[0]!.balance - (feesBefore?.balance ?? 0n)).toBe(25n);
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('0.999'), held: 0n });
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it('rounds the fee down to the micro-USD: the seller gets the remainder', async () => {
    const { paymentId } = await heldPayment(7n);

    expect(await ledger.capture({ paymentId, feeBps: 250 })).toMatchObject({ fee: 0n, sellerAmount: 7n });
  });

  it('moves money once when a capture runs twice, or concurrently (LG-3)', async () => {
    const { seller, paymentId } = await heldPayment(usd('0.5'));

    const results = await Promise.all([ledger.capture({ paymentId, feeBps: 1_000 }), ledger.capture({ paymentId, feeBps: 1_000 })]);
    const again = await ledger.capture({ paymentId, feeBps: 1_000 });

    expect(results.map(result => result.sellerAmount)).toEqual([usd('0.45'), usd('0.45')]);
    expect(again.sellerAmount).toBe(usd('0.45'));
    const [earned] = await database.db.select().from(balances).where(sql`${balances.ledgerAccountId} = ${ledgerAccountIds.earned(seller)}`);
    expect(earned?.balance).toBe(usd('0.45'));
  });

  it('gives a held payment back once when a release runs twice, with the key\'s spend (LG-3, LG-6)', async () => {
    const { buyer, paymentId } = await heldPayment(usd('0.5'));

    const [first, second] = await Promise.all([ledger.release({ paymentId }), ledger.release({ paymentId })]);
    await ledger.release({ paymentId });

    expect([first.payment.status, second.payment.status]).toEqual(['released', 'released']);
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('1'), held: 0n });
    expect(await ledger.keySpend([buyer.keyId], fixtureDay(0, 5))).toEqual(new Map([[buyer.keyId, { today: 0n, total: 0n }]]));
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it('refuses to release a captured payment, or capture a released one (LG-8)', async () => {
    const captured = await heldPayment();
    const released = await heldPayment();
    await ledger.capture({ paymentId: captured.paymentId, feeBps: 0 });
    await ledger.release({ paymentId: released.paymentId });

    expect(await thrown(ledger.release({ paymentId: captured.paymentId }))).toBeInstanceOf(InvalidPaymentStatusChangeError);
    expect(await thrown(ledger.capture({ paymentId: released.paymentId, feeBps: 0 }))).toBeInstanceOf(InvalidPaymentStatusChangeError);
    expect(await thrown(ledger.capture({ paymentId: 'pay_missing', feeBps: 0 }))).toBeInstanceOf(InvalidPaymentStatusChangeError);
  });

  it('keeps every balance it shouldn\'t overdraw at zero or above, in the database too (LG-2)', async () => {
    const buyer = await newBuyer('1');

    const error = await thrown(database.db.update(balances).set({ balance: -1n }).where(sql`${balances.ledgerAccountId} = ${ledgerAccountIds.available(buyer.accountId)}`)) as { cause?: { constraint?: string } };

    expect(error.cause?.constraint).toBe('balances_not_negative_check');
  });
});

describe('payment status changes (LG-8, PR-10)', () => {
  const recorded = async (status: 'held' | 'verified') => {
    const buyer = await newBuyer('0');
    const payments = createPaymentRepository({ db: database.db, clock });

    return { payments, payment: await payments.create({ ...payment(buyer, 10n), rail: status === 'held' ? 'credits' : 'x402', status }) };
  };

  it.each([
    ['captured', 'held'],
    ['released', 'captured'],
    ['settled', 'cancelled'],
    ['cancelled', 'settled'],
    ['held', 'settled'],
    ['verified', 'captured'],
  ] as const)('refuses %s → %s', async (from, to) => {
    const { payments, payment: created } = await recorded(from === 'held' || from === 'captured' || from === 'released' ? 'held' : 'verified');
    const path: Record<string, readonly PaymentStatus[]> = { captured: ['captured'], released: ['released'], settled: ['settled'], cancelled: ['cancelled'], held: [], verified: [] };
    for (const step of path[from]!)
      await payments.changeStatus({ paymentId: created.id, to: step });

    const error = await thrown(payments.changeStatus({ paymentId: created.id, to }));

    expect(error).toBeInstanceOf(InvalidPaymentStatusChangeError);
    expect((await payments.find(created.id))?.status).toBe(from);
  });

  it('moves a verified payment through settling to settled, with its hash and the review flag', async () => {
    const { payments, payment: created } = await recorded('verified');

    await payments.changeStatus({ paymentId: created.id, to: 'settling', transactionHash: '0xabc' });
    const settled = await payments.changeStatus({ paymentId: created.id, to: 'settled', fee: 1n, needsReview: true });

    expect(settled).toMatchObject({ status: 'settled', transactionHash: '0xabc', fee: 1n, needsReview: true });
  });

  it('records the billing decision while the payment is open, and refuses it after (rule 5)', async () => {
    const { payments, payment: created } = await recorded('held');

    const decided = await payments.recordDecision({ paymentId: created.id, decision: 'billable', upstreamStatus: 200, upstreamLatencyMs: 12 });
    await payments.changeStatus({ paymentId: created.id, to: 'captured' });

    expect(decided).toMatchObject({ decision: 'billable', upstreamStatus: 200, upstreamLatencyMs: 12, status: 'held' });
    expect(await thrown(payments.recordDecision({ paymentId: created.id, decision: 'not_billable', upstreamStatus: 500, upstreamLatencyMs: 1 })))
      .toBeInstanceOf(PaymentFinalizedError);
  });
});

describe('reads (LG-10)', () => {
  it('sums a service\'s captured earnings by rail, with the fee, and leaves out open and released payments', async () => {
    const buyer = await newBuyer('1');
    const seller = await newAccount();
    const serviceId = await newService(seller);
    const ids: string[] = [];
    for (const amount of [usd('0.001'), usd('0.002'), usd('0.003')]) {
      const result = await hold(buyer, amount, {}, { sellerAccountId: seller, serviceId });
      ids.push(result.ok ? result.payment.id : '');
    }
    await ledger.capture({ paymentId: ids[0]!, feeBps: 250 });
    await ledger.capture({ paymentId: ids[1]!, feeBps: 250 });
    await ledger.release({ paymentId: ids[2]! });

    expect(await createPaymentRepository({ db: database.db, clock }).earnings(serviceId)).toEqual({
      calls: 2,
      earnedByRail: { credits: 975n + 1_950n },
      earned: 975n + 1_950n,
      fee: 25n + 50n,
      paidOut: 0n,
    });
  });

  it('pages a buyer\'s payments newest first', async () => {
    const buyer = await newBuyer('1');
    const paymentIds: string[] = [];
    for (let index = 0; index < 5; index++) {
      clock.advance(1_000);
      const result = await hold(buyer, 1n);
      paymentIds.push(result.ok ? result.payment.id : '');
    }
    const payments = createPaymentRepository({ db: database.db, clock });

    const first = await payments.listForBuyer({ buyerAccountId: buyer.accountId, limit: 2 });
    const second = await payments.listForBuyer({ buyerAccountId: buyer.accountId, limit: 2, after: first.next });
    const last = await payments.listForBuyer({ buyerAccountId: buyer.accountId, limit: 2, after: second.next });

    expect([...first.payments, ...second.payments, ...last.payments].map(item => item.id)).toEqual([...paymentIds].reverse());
    expect(last.next).toBeUndefined();
  });
});

describe('amounts (LG-1)', () => {
  it('keeps every amount as integer micro-USD in a bigint column, exact past Number.MAX_SAFE_INTEGER', async () => {
    const columns = (await database.db.execute<{ column: string; data_type: string }>(sql`
      select table_name || '.' || column_name as column, data_type from information_schema.columns
      where (table_name, column_name) in (
        ('ledger_entries', 'amount'), ('balances', 'balance'), ('payments', 'amount'), ('payments', 'fee'), ('key_daily_spend', 'spent'),
        ('key_total_spend', 'spent'), ('api_keys', 'allowance'), ('api_keys', 'daily_budget'), ('api_keys', 'max_price')
      )
    `)).rows;
    const accountId = await newAccount();
    const amount = BigInt(Number.MAX_SAFE_INTEGER) + 2n;

    await ledger.credit({ accountId, amount, reference: `large-${accountId}` });

    expect(columns).toHaveLength(9);
    expect(columns.filter(column => column.data_type !== 'bigint')).toEqual([]);
    expect(await ledger.balance(accountId)).toEqual({ available: amount, held: 0n });
  });
});

describe('payments rows (LG-7, LG-5)', () => {
  const settledX402 = async (sellerAccountId: string, serviceId: string, amount: bigint, feeBps: number) => {
    counter += 1;
    const payments = createPaymentRepository({ db: database.db, clock });
    const created = await payments.create({
      id: `pay_x402_${counter}`,
      requestId: `req-x402-${counter}`,
      kind: 'service',
      rail: 'x402',
      buyerAccountId: undefined,
      keyId: undefined,
      sellerAccountId,
      serviceId,
      routeKey: 'getWeather',
      targetHost: undefined,
      targetPath: undefined,
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      // Past a bigint column: numeric(78, 0) holds any 256-bit amount
      atomicAmount: 10n ** 30n,
      amount,
      status: 'verified',
    });
    await payments.recordDecision({ paymentId: created.id, decision: 'billable', upstreamStatus: 200, upstreamLatencyMs: 42 });
    clock.advance(1_000);
    await payments.changeStatus({ paymentId: created.id, to: 'settling', transactionHash: '0xfeed' });
    await payments.changeStatus({ paymentId: created.id, to: 'settled', fee: amount * BigInt(feeBps) / 10_000n, receipt: 'receipt-1', needsReview: false });

    return { payments, created };
  };

  it('stores every field of a paid call: a service\'s x402 payment, and a routed call\'s target (LG-7)', async () => {
    const seller = await newAccount();
    const serviceId = await newService(seller);
    const createdAt = clock.now();
    const { payments, created } = await settledX402(seller, serviceId, usd('0.01'), 250);
    const buyer = await newBuyer('1');
    const routed = await hold(buyer, usd('0.002'), {}, { kind: 'routed', targetHost: 'api.example.com', targetPath: '/v1/quote' });

    expect(await payments.find(created.id)).toEqual({
      id: created.id,
      requestId: created.requestId,
      kind: 'service',
      rail: 'x402',
      buyerAccountId: undefined,
      keyId: undefined,
      sellerAccountId: seller,
      serviceId,
      routeKey: 'getWeather',
      targetHost: undefined,
      targetPath: undefined,
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      atomicAmount: 10n ** 30n,
      amount: usd('0.01'),
      fee: 250n,
      decision: 'billable',
      upstreamStatus: 200,
      upstreamLatencyMs: 42,
      status: 'settled',
      transactionHash: '0xfeed',
      receipt: 'receipt-1',
      needsReview: false,
      createdAt,
      updatedAt: new Date(createdAt.getTime() + 1_000),
    });
    expect(routed.ok && await payments.find(routed.payment.id)).toMatchObject({
      kind: 'routed', rail: 'credits', buyerAccountId: buyer.accountId, keyId: buyer.keyId, serviceId: undefined, targetHost: 'api.example.com', targetPath: '/v1/quote',
    });
  });

  it('counts earnings in the USD fixed at payment time, never from the asset amount (LG-5)', async () => {
    const buyer = await newBuyer('1');
    const seller = await newAccount();
    const serviceId = await newService(seller);
    const held = await hold(buyer, usd('0.001'), {}, { sellerAccountId: seller, serviceId });
    await ledger.capture({ paymentId: held.ok ? held.payment.id : '', feeBps: 250 });

    // $25 recorded at payment time, whatever 10^30 atomic units of the asset are worth later
    await settledX402(seller, serviceId, usd('25'), 250);

    expect(await createPaymentRepository({ db: database.db, clock }).earnings(serviceId)).toEqual({
      calls: 2,
      earnedByRail: { credits: 975n, x402: usd('24.375') },
      earned: 975n + usd('24.375'),
      fee: 25n + usd('0.625'),
      paidOut: 0n,
    });
  });
});

describe('a hold just before midnight UTC (LG-6, AR5, T08 fix)', () => {
  it('counts the spend on the day of the payment\'s createdAt, so a release after midnight gives it back cleanly', async () => {
    const buyer = await newBuyer('10', { dailyBudget: '1' });
    // Every read moves the clock by 1 ms: a hold that read it twice would straddle midnight
    let now = new Date(fixtureTime(0, 5, 23, 59, 59, 999)).getTime();
    const ticking = createLedger({ db: database.db, clock: { now: () => new Date(now++) }, ids: randomIdGenerator });
    const late = await ticking.hold({ payment: payment(buyer, usd('0.5')), dailyBudget: usd('1'), allowance: undefined });
    // The next day's spend is smaller than the late hold
    clock.set(fixtureTime(0, 6, 0, 0, 1, 0));
    await hold(buyer, usd('0.1'), { dailyBudget: '1' });

    const released = await ledger.release({ paymentId: late.ok ? late.payment.id : '' });

    expect(late.ok && late.payment.createdAt).toEqual(new Date(fixtureTime(0, 5, 23, 59, 59, 999)));
    expect(released.payment.status).toBe('released');
    expect(await ledger.keySpend([buyer.keyId], fixtureDay(0, 5))).toEqual(new Map([[buyer.keyId, { today: 0n, total: usd('0.1') }]]));
    expect(await ledger.keySpend([buyer.keyId], fixtureDay(0, 6))).toEqual(new Map([[buyer.keyId, { today: usd('0.1'), total: usd('0.1') }]]));
    clock.set(fixtureTime(0, 5, 12, 0, 0, 0));
  });
});

describe('expired holds (LG-9)', () => {
  it('lists payments still held from before a time, oldest first, a page at a time', async () => {
    const buyer = await newBuyer('1');
    const payments = createPaymentRepository({ db: database.db, clock });
    const held: string[] = [];
    clock.set(fixtureTime(0, 4, 10, 0, 0, 0));
    for (let index = 0; index < 3; index++) {
      const result = await hold(buyer, 1n);
      held.push(result.ok ? result.payment.id : '');
    }
    const captured = await hold(buyer, 1n);
    clock.set(fixtureTime(0, 4, 10, 10, 0, 0));
    const recent = await hold(buyer, 1n);
    await ledger.release({ paymentId: captured.ok ? captured.payment.id : '' });
    clock.set(fixtureTime(0, 5, 12, 0, 0, 0));
    const createdBefore = new Date(fixtureTime(0, 4, 10, 5, 0, 0));

    const first = await payments.listExpiredHolds({ createdBefore, limit: 2 });
    const second = await payments.listExpiredHolds({ createdBefore, limit: 2, after: first.at(-1)! });
    const mine = (list: readonly { id: string }[]) => list.map(item => item.id).filter(id => held.includes(id) || id === (recent.ok ? recent.payment.id : ''));

    expect([...mine(first), ...mine(second)]).toEqual([...held].sort((left, right) => left < right ? -1 : 1));
    expect([...first, ...second].every(item => item.status === 'held' && item.createdAt < createdBefore)).toBe(true);
  });
});

describe('settled on-chain payments (LG-4, LG-8, PR-12, step 5)', () => {
  const verifiedX402 = async (amount = usd('0.01')) => {
    const seller = await newAccount();
    const serviceId = await newService(seller);
    counter += 1;
    const payments = createPaymentRepository({ db: database.db, clock });
    const payment = await payments.create({
      id: `pay_onchain_${counter}`, requestId: `req-onchain-${counter}`, kind: 'service', rail: 'x402', buyerAccountId: undefined, keyId: undefined,
      sellerAccountId: seller, serviceId, routeKey: 'getWeather', targetHost: undefined, targetPath: undefined,
      network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', atomicAmount: 10_000n, amount, status: 'verified',
    });

    return { payments, payment, seller };
  };
  const balanceOf = async (ledgerAccountId: string) =>
    (await database.db.select().from(balances).where(sql`${balances.ledgerAccountId} = ${ledgerAccountId}`))[0]?.balance;

  it('books the asset\'s treasury into the seller\'s earnings and the fee, once, with the hash', async () => {
    const { payment, seller } = await verifiedX402();
    const treasuryBefore = await balanceOf(ledgerAccountIds.treasury('base-usdc')) ?? 0n;
    const input = { paymentId: payment.id, feeBps: 250, asset: 'base-usdc', transactionHash: '0xabc', receipt: 'eyJzdWNjZXNzIjp0cnVlfQ', needsReview: false };

    const first = await ledger.settle(input);
    const again = await ledger.settle(input);

    expect(first).toMatchObject({ fee: 250n, sellerAmount: 9_750n, payment: { status: 'settled', transactionHash: '0xabc', receipt: input.receipt, needsReview: false, fee: 250n } });
    expect(again).toEqual(first);
    expect(await balanceOf(ledgerAccountIds.earned(seller))).toBe(9_750n);
    expect(await balanceOf(ledgerAccountIds.treasury('base-usdc'))).toBe(treasuryBefore - usd('0.01'));
    expect(await unbalancedTransactions()).toEqual([]);
    expect(await negativeBalances()).toEqual([]);
  });

  it('settles a payment that was settling, clears its settle request, and flags it for review when asked', async () => {
    const { payments, payment } = await verifiedX402();
    await payments.changeStatus({ paymentId: payment.id, to: 'settling', settlementRequest: { paymentPayload: { x402Version: 2 } } });

    const settled = await ledger.settle({ paymentId: payment.id, feeBps: 0, asset: 'base-usdc', transactionHash: '0xdef', receipt: undefined, needsReview: true });

    expect(settled.payment).toMatchObject({ status: 'settled', needsReview: true, transactionHash: '0xdef' });
    expect((await payments.listSettling({ limit: 100 })).map(item => item.payment.id)).not.toContain(payment.id);
    const { rows } = await database.db.execute<{ request: unknown }>(sql`select settlement_request as request from payments where id = ${payment.id}`);
    expect(rows[0]?.request).toBeNull();
  });

  it('refuses a credits payment, and one that was cancelled (LG-8)', async () => {
    const buyer = await newBuyer('1');
    const seller = await newAccount();
    const held = await hold(buyer, 1_000n, {}, { sellerAccountId: seller, serviceId: await newService(seller) });
    const { payments, payment } = await verifiedX402();
    await payments.changeStatus({ paymentId: payment.id, to: 'cancelled' });

    await expect(ledger.settle({ paymentId: held.ok ? held.payment.id : '', feeBps: 0, asset: 'base-usdc', transactionHash: undefined, receipt: undefined, needsReview: false }))
      .rejects.toBeInstanceOf(InvalidPaymentStatusChangeError);
    await expect(ledger.settle({ paymentId: payment.id, feeBps: 0, asset: 'base-usdc', transactionHash: undefined, receipt: undefined, needsReview: false }))
      .rejects.toBeInstanceOf(InvalidPaymentStatusChangeError);
  });

  it('lists settling payments oldest first, with the settle request to repeat (WK-6)', async () => {
    const { payments } = await verifiedX402();
    const settling: string[] = [];
    for (let index = 0; index < 3; index++) {
      clock.advance(1_000);
      const { payment } = await verifiedX402();
      await payments.changeStatus({ paymentId: payment.id, to: 'settling', transactionHash: index === 0 ? '0x1' : undefined, settlementRequest: { index } });
      settling.push(payment.id);
    }

    const first = await payments.listSettling({ limit: 2 });
    const rest = await payments.listSettling({ limit: 10, after: first.at(-1)!.payment });
    const mine = [...first, ...rest].filter(item => settling.includes(item.payment.id));

    expect(mine.map(item => item.payment.id)).toEqual(settling);
    expect(mine.map(item => item.settlementRequest)).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
    expect(mine[0]?.payment.transactionHash).toBe('0x1');
    clock.set(fixtureTime(0, 5, 12, 0, 0, 0));
  });
});

describe('the flat fee per payment on a settlement (P-2, LG-4, LG-10)', () => {
  const verified = async (amount: bigint, changes: Partial<NewPayment> = {}) => {
    const seller = await newAccount();
    const serviceId = await newService(seller);
    counter += 1;
    const payments = createPaymentRepository({ db: database.db, clock });
    const payment = await payments.create({
      id: `pay_flat_${counter}`, requestId: `req-flat-${counter}`, kind: 'service', rail: 'x402', buyerAccountId: undefined, keyId: undefined,
      sellerAccountId: seller, serviceId, routeKey: 'getWeather', targetHost: undefined, targetPath: undefined,
      network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', atomicAmount: amount, amount, status: 'verified', ...changes,
    });

    return { payments, payment, seller, serviceId };
  };
  const balanceOf = async (ledgerAccountId: string) =>
    (await database.db.select().from(balances).where(sql`${balances.ledgerAccountId} = ${ledgerAccountId}`))[0]?.balance ?? 0n;
  const settle = (paymentId: string, feeBps: number, feePerPayment?: bigint) => ledger.settle({
    paymentId, feeBps, ...(feePerPayment === undefined ? {} : { feePerPayment }), asset: 'base-usdc', transactionHash: '0xflat', receipt: undefined, needsReview: false,
  });

  it('books $0.0005 of a $0.001 payment as the platform\'s fee and $0.0005 as the seller\'s, and the earnings view shows it', async () => {
    const { payments, payment, seller, serviceId } = await verified(usd('0.001'));
    const feesBefore = await balanceOf(ledgerAccountIds.fees);

    const result = await settle(payment.id, 0, usd('0.0005'));

    expect(result).toMatchObject({ fee: 500n, sellerAmount: 500n, payment: { status: 'settled', fee: 500n } });
    expect(await balanceOf(ledgerAccountIds.earned(seller))).toBe(500n);
    expect(await balanceOf(ledgerAccountIds.fees) - feesBefore).toBe(500n);
    expect(await payments.earnings(serviceId)).toMatchObject({ calls: 1, earned: 500n, earnedByRail: { x402: 500n }, fee: 500n });
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it('caps the fee at a $0.0003 payment\'s amount: the seller earns 0 and nothing goes negative', async () => {
    const { payments, payment, seller, serviceId } = await verified(usd('0.0003'));
    const feesBefore = await balanceOf(ledgerAccountIds.fees);

    const result = await settle(payment.id, 0, usd('0.0005'));

    expect(result).toMatchObject({ fee: 300n, sellerAmount: 0n, payment: { fee: 300n } });
    expect(await balanceOf(ledgerAccountIds.earned(seller))).toBe(0n);
    expect(await balanceOf(ledgerAccountIds.fees) - feesBefore).toBe(300n);
    expect(await payments.earnings(serviceId)).toMatchObject({ earned: 0n, fee: 300n });
    expect(await negativeBalances()).toEqual([]);
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it('adds the flat fee to feeBps\'s share: $0.0015 on a $0.01 payment at 1000 bps', async () => {
    const { payment, seller } = await verified(usd('0.01'));

    const result = await settle(payment.id, 1_000, usd('0.0005'));

    expect(result).toMatchObject({ fee: 1_500n, sellerAmount: 8_500n });
    expect(await balanceOf(ledgerAccountIds.earned(seller))).toBe(8_500n);
  });

  it('takes no flat fee when none is given, as for MPP and a facilitator without one', async () => {
    const { payment } = await verified(usd('0.001'), { rail: 'mpp', network: 'eip155:42431', asset: '0x20c0000000000000000000000000000000000000' });

    expect(await settle(payment.id, 250)).toMatchObject({ fee: 25n, sellerAmount: 975n });
  });

  it('keeps a routed payment\'s fee to the routing fee in its quote, flat fee or not (RT-5)', async () => {
    counter += 1;
    const payments = createPaymentRepository({ db: database.db, clock });
    const payment = await payments.create({
      id: `pay_flat_routed_${counter}`, requestId: undefined, kind: 'routed', rail: 'x402', buyerAccountId: undefined, keyId: undefined,
      sellerAccountId: undefined, serviceId: undefined, routeKey: undefined, targetHost: 'api.target.dev', targetPath: '/v1/pools',
      network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', atomicAmount: 1_100n, amount: 1_100n, status: 'verified',
    });
    await createRoutingRepository({ db: database.db, clock }).recordTargetPayment({
      paymentId: payment.id, protocol: 'x402', network: 'eip155:84532', asset: 'base-usdc', amount: 1_000n, atomicAmount: 1_000n,
      payTo: '0x3333333333333333333333333333333333333333', signatureId: `sig_${counter}`,
    });
    const [feesBefore, routingFeesBefore] = [await balanceOf(ledgerAccountIds.fees), await balanceOf(ledgerAccountIds.routingFees)];

    const result = await settle(payment.id, 0, usd('0.0005'));

    expect(result).toMatchObject({ fee: 100n, sellerAmount: 0n, payment: { kind: 'routed', status: 'settled', fee: 100n } });
    expect(await balanceOf(ledgerAccountIds.routingFees) - routingFeesBefore).toBe(100n);
    expect(await balanceOf(ledgerAccountIds.fees) - feesBefore).toBe(0n);
    expect(await unbalancedTransactions()).toEqual([]);
  });
});
