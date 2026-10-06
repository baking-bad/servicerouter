import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Clock, IdGenerator, MicroUsd } from '@servicerouter/common';
import {
  CreditReferenceConflictError, InvalidPaymentStatusChangeError, splitFee, utcDay, type CaptureResult, type CreditsBalance, type HoldInput,
  type HoldRefusal, type HoldResult, type KeySpend, type Payment,
} from '@servicerouter/core';

import { createPaymentRepository } from './paymentRepository.js';
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from './postgres.js';
import { balances, keyDailySpend, keyTotalSpend, ledgerAccounts, ledgerEntries, ledgerTransactions } from './schema/ledger.js';

/** The ledger accounts' IDs (LG-1): an account's own, and the platform's. */
export const ledgerAccountIds = {
  available: (accountId: string) => `${accountId}:available`,
  held: (accountId: string) => `${accountId}:held`,
  earned: (accountId: string) => `${accountId}:earned`,
  fees: 'platform:fees',
  depositsClearing: 'platform:deposits_clearing',
} as const;

export interface LedgerOptions {
  // The database, or a transaction to join: each operation then runs in a savepoint of it
  readonly db: DatabaseExecutor;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface CreditResult {
  readonly transactionId: string;
  readonly createdAt: Date;
  // The reference was used before, for the same account and amount: nothing moved this time
  readonly replayed: boolean;
}

/**
 * The Ledger's money movements (LG-1 to LG-6): double entry, one database transaction each, keyed by
 * operation and reference. Implements the rails' CreditsLedger port.
 */
export interface Ledger {
  /** Deposits clearing → the buyer's available credits. Idempotent by `reference`. Throws CreditReferenceConflictError for a reused one. */
  credit(input: { readonly accountId: string; readonly amount: MicroUsd; readonly reference: string; readonly requestId?: string }): Promise<CreditResult>;
  hold(input: HoldInput): Promise<HoldResult>;
  capture(input: { readonly paymentId: string; readonly feeBps: number }): Promise<CaptureResult>;
  release(input: { readonly paymentId: string }): Promise<{ readonly payment: Payment }>;
  balance(accountId: string): Promise<CreditsBalance>;
  /** Each key's spend: on the given UTC day, and in total. Keys without spend aren't in the map. */
  keySpend(keyIds: readonly string[], day: string): Promise<ReadonlyMap<string, KeySpend>>;
}

interface Posting {
  readonly ledgerAccountId: string;
  // Added to the account's balance
  readonly amount: bigint;
}

interface LedgerAccount {
  readonly id: string;
  readonly accountId: string | undefined;
  readonly type: string;
  readonly mayGoNegative: boolean;
}

// A refused hold rolls its transaction back, then becomes a result
class HoldRefused extends Error {
  constructor(readonly refusal: HoldRefusal) {
    super(refusal);
  }
}

const accountsOf = (accountId: string, ...types: readonly ('available' | 'held' | 'earned')[]): LedgerAccount[] =>
  types.map(type => ({ id: ledgerAccountIds[type](accountId), accountId, type, mayGoNegative: false }));
const platformFees: LedgerAccount = { id: ledgerAccountIds.fees, accountId: undefined, type: 'fees', mayGoNegative: false };
// Money enters through it, so its balance is minus everything deposited
const depositsClearing: LedgerAccount = { id: ledgerAccountIds.depositsClearing, accountId: undefined, type: 'deposits_clearing', mayGoNegative: true };

export const createLedger = ({ db, clock, ids }: LedgerOptions): Ledger => {
  const ensureAccounts = async (tx: DatabaseTransaction, list: readonly LedgerAccount[], now: Date): Promise<void> => {
    await tx.insert(ledgerAccounts)
      .values(list.map(account => ({ id: account.id, accountId: account.accountId ?? null, type: account.type, createdAt: now })))
      .onConflictDoNothing();
    await tx.insert(balances)
      .values(list.map(account => ({ ledgerAccountId: account.id, balance: 0n, mayGoNegative: account.mayGoNegative, updatedAt: now })))
      .onConflictDoNothing();
  };

  // The transaction's ID, or undefined when this operation and reference already moved money (LG-3)
  const insertTransaction = async (tx: DatabaseTransaction, operation: string, reference: string, requestId: string | undefined, now: Date) => {
    const [row] = await tx.insert(ledgerTransactions)
      .values({ id: ids.next(), operation, reference, requestId: requestId ?? null, createdAt: now })
      .onConflictDoNothing({ target: [ledgerTransactions.operation, ledgerTransactions.reference] })
      .returning({ id: ledgerTransactions.id });

    return row?.id;
  };

  /**
   * Posts the entries and updates the balances (LG-2). Balances change in account ID order, so
   * concurrent postings lock rows in one order and never deadlock. Returns the first account that
   * would go below zero, or doesn't exist: the caller rolls back.
   */
  const post = async (tx: DatabaseTransaction, transactionId: string, postings: readonly Posting[], now: Date): Promise<string | undefined> => {
    const entries = postings.filter(posting => posting.amount !== 0n);
    if (entries.reduce((sum, posting) => sum + posting.amount, 0n) !== 0n)
      throw new Error('A ledger transaction\'s entries must sum to zero');

    for (const { ledgerAccountId, amount } of [...entries].sort((left, right) => left.ledgerAccountId < right.ledgerAccountId ? -1 : 1)) {
      const updated = await tx.update(balances)
        .set({ balance: sql`${balances.balance} + ${amount}::bigint`, updatedAt: now })
        .where(and(eq(balances.ledgerAccountId, ledgerAccountId), sql`(${balances.mayGoNegative} or ${balances.balance} + ${amount}::bigint >= 0)`))
        .returning({ id: balances.ledgerAccountId });
      if (updated.length === 0)
        return ledgerAccountId;
    }
    if (entries.length > 0)
      await tx.insert(ledgerEntries).values(entries.map(posting => ({ id: ids.next(), transactionId, ...posting })));

    return undefined;
  };

  // A held amount counts against the key's spend; a release gives it back (LG-6)
  const addSpend = async (tx: DatabaseTransaction, keyId: string, day: string, amount: bigint, dailyBudget: bigint, allowance: bigint | undefined): Promise<HoldRefusal | undefined> => {
    if (amount > dailyBudget)
      return 'key_budget_exceeded';
    const [daily] = await tx.insert(keyDailySpend).values({ keyId, day, spent: amount })
      .onConflictDoUpdate({
        target: [keyDailySpend.keyId, keyDailySpend.day],
        set: { spent: sql`${keyDailySpend.spent} + ${amount}::bigint` },
        setWhere: sql`${keyDailySpend.spent} + ${amount}::bigint <= ${dailyBudget}::bigint`,
      })
      .returning({ spent: keyDailySpend.spent });
    if (!daily)
      return 'key_budget_exceeded';

    if (allowance !== undefined && amount > allowance)
      return 'key_allowance_exceeded';
    const [total] = await tx.insert(keyTotalSpend).values({ keyId, spent: amount })
      .onConflictDoUpdate({
        target: keyTotalSpend.keyId,
        set: { spent: sql`${keyTotalSpend.spent} + ${amount}::bigint` },
        ...(allowance === undefined ? {} : { setWhere: sql`${keyTotalSpend.spent} + ${amount}::bigint <= ${allowance}::bigint` }),
      })
      .returning({ spent: keyTotalSpend.spent });

    return total ? undefined : 'key_allowance_exceeded';
  };

  const giveBackSpend = async (tx: DatabaseTransaction, keyId: string, day: string, amount: bigint): Promise<void> => {
    await tx.update(keyDailySpend).set({ spent: sql`${keyDailySpend.spent} - ${amount}::bigint` })
      .where(and(eq(keyDailySpend.keyId, keyId), eq(keyDailySpend.day, day)));
    await tx.update(keyTotalSpend).set({ spent: sql`${keyTotalSpend.spent} - ${amount}::bigint` })
      .where(eq(keyTotalSpend.keyId, keyId));
  };

  // A held credits payment, locked for the rest of the transaction
  const lockHeld = async (tx: DatabaseTransaction, paymentId: string, to: 'captured' | 'released'): Promise<Payment> => {
    const payment = await createPaymentRepository({ db: tx, clock }).lock(paymentId);
    if (!payment || payment.status !== 'held' || payment.rail !== 'credits' || !payment.buyerAccountId)
      throw new InvalidPaymentStatusChangeError(paymentId, payment?.status, to);

    return payment;
  };

  return {
    credit: ({ accountId, amount, reference, requestId }) => withTransaction(db, async tx => {
      if (amount <= 0n)
        throw new RangeError('A credit must be more than zero');

      const now = clock.now();
      const available = ledgerAccountIds.available(accountId);
      await ensureAccounts(tx, [...accountsOf(accountId, 'available', 'held'), depositsClearing], now);
      const transactionId = await insertTransaction(tx, 'credit', reference, requestId, now);
      if (!transactionId) {
        // The reference was used before: the same credit again is a replay, anything else a conflict
        const [existing] = await tx.select({ id: ledgerTransactions.id, createdAt: ledgerTransactions.createdAt, ledgerAccountId: ledgerEntries.ledgerAccountId, amount: ledgerEntries.amount })
          .from(ledgerTransactions)
          .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, ledgerTransactions.id))
          .where(and(eq(ledgerTransactions.operation, 'credit'), eq(ledgerTransactions.reference, reference), sql`${ledgerEntries.amount} > 0`));
        if (existing?.ledgerAccountId !== available || existing.amount !== amount)
          throw new CreditReferenceConflictError();

        return { transactionId: existing.id, createdAt: existing.createdAt, replayed: true };
      }

      await post(tx, transactionId, [{ ledgerAccountId: depositsClearing.id, amount: -amount }, { ledgerAccountId: available, amount }], now);

      return { transactionId, createdAt: now, replayed: false };
    }),

    hold: async ({ payment, dailyBudget, allowance }) => {
      try {
        return await withTransaction(db, async (tx): Promise<HoldResult> => {
          const now = clock.now();
          const payments = createPaymentRepository({ db: tx, clock });
          const transactionId = await insertTransaction(tx, 'hold', payment.id, payment.requestId, now);
          if (!transactionId) {
            // The same hold again: the first one stands
            const existing = await payments.find(payment.id);
            if (!existing)
              throw new Error('A hold transaction exists without its payment');

            return { ok: true, payment: existing };
          }

          const { buyerAccountId, keyId, amount } = payment;
          // Balance, then today's spend, then the total: every hold locks rows in the same order
          if (await post(tx, transactionId, [
            { ledgerAccountId: ledgerAccountIds.available(buyerAccountId), amount: -amount },
            { ledgerAccountId: ledgerAccountIds.held(buyerAccountId), amount },
          ], now))
            throw new HoldRefused('insufficient_balance');
          const refusal = await addSpend(tx, keyId, utcDay(now), amount, dailyBudget, allowance);
          if (refusal)
            throw new HoldRefused(refusal);

          return { ok: true, payment: await payments.create({ ...payment, status: 'held' }) };
        });
      }
      catch (error) {
        if (error instanceof HoldRefused)
          return { ok: false, refusal: error.refusal };
        throw error;
      }
    },

    capture: ({ paymentId, feeBps }) => withTransaction(db, async tx => {
      const payments = createPaymentRepository({ db: tx, clock });
      const current = await payments.lock(paymentId);
      // A second capture moves nothing (LG-3)
      if (current?.status === 'captured')
        return { payment: current, fee: current.fee ?? 0n, sellerAmount: current.amount - (current.fee ?? 0n) };

      const payment = await lockHeld(tx, paymentId, 'captured');
      if (!payment.sellerAccountId)
        throw new InvalidPaymentStatusChangeError(paymentId, payment.status, 'captured');

      const now = clock.now();
      const { fee, sellerAmount } = splitFee(payment.amount, feeBps);
      await ensureAccounts(tx, [...accountsOf(payment.sellerAccountId, 'earned'), platformFees], now);
      const transactionId = await insertTransaction(tx, 'capture', paymentId, payment.requestId, now);
      if (!transactionId || await post(tx, transactionId, [
        { ledgerAccountId: ledgerAccountIds.held(payment.buyerAccountId!), amount: -payment.amount },
        { ledgerAccountId: ledgerAccountIds.earned(payment.sellerAccountId), amount: sellerAmount },
        { ledgerAccountId: platformFees.id, amount: fee },
      ], now))
        throw new Error('The held amount is missing from the buyer\'s held balance');

      return { payment: await payments.changeStatus({ paymentId, to: 'captured', fee }), fee, sellerAmount };
    }),

    release: ({ paymentId }) => withTransaction(db, async tx => {
      const payments = createPaymentRepository({ db: tx, clock });
      const current = await payments.lock(paymentId);
      // A second release moves nothing (LG-3)
      if (current?.status === 'released')
        return { payment: current };

      const payment = await lockHeld(tx, paymentId, 'released');
      const buyer = payment.buyerAccountId!;
      const now = clock.now();
      const transactionId = await insertTransaction(tx, 'release', paymentId, payment.requestId, now);
      if (!transactionId || await post(tx, transactionId, [
        { ledgerAccountId: ledgerAccountIds.held(buyer), amount: -payment.amount },
        { ledgerAccountId: ledgerAccountIds.available(buyer), amount: payment.amount },
      ], now))
        throw new Error('The held amount is missing from the buyer\'s held balance');
      // The spend goes back to the day it was counted on
      if (payment.keyId)
        await giveBackSpend(tx, payment.keyId, utcDay(payment.createdAt), payment.amount);

      return { payment: await payments.changeStatus({ paymentId, to: 'released' }) };
    }),

    balance: async accountId => {
      const available = ledgerAccountIds.available(accountId);
      const rows = await db.select({ id: balances.ledgerAccountId, balance: balances.balance }).from(balances)
        .where(inArray(balances.ledgerAccountId, [available, ledgerAccountIds.held(accountId)]));

      return {
        available: rows.find(row => row.id === available)?.balance ?? 0n,
        held: rows.find(row => row.id !== available)?.balance ?? 0n,
      };
    },

    keySpend: async (keyIds, day) => {
      const spend = new Map<string, { today: bigint; total: bigint }>();
      if (keyIds.length === 0)
        return spend;

      const [daily, totals] = await Promise.all([
        db.select().from(keyDailySpend).where(and(inArray(keyDailySpend.keyId, [...keyIds]), eq(keyDailySpend.day, day))),
        db.select().from(keyTotalSpend).where(inArray(keyTotalSpend.keyId, [...keyIds])),
      ]);
      for (const { keyId, spent } of totals)
        spend.set(keyId, { today: 0n, total: spent });
      for (const { keyId, spent } of daily)
        spend.set(keyId, { today: spent, total: spend.get(keyId)?.total ?? 0n });

      return spend;
    },
  };
};
