import { and, eq, inArray, sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';

import type { Clock, IdGenerator, MicroUsd } from '@servicerouter/common';
import {
  CreditReferenceConflictError, InvalidPaymentStatusChangeError, splitFee, utcDay, type CaptureResult, type CreditsBalance, type HoldInput,
  type HoldRefusal, type HoldResult, type KeySpend, type Payment, type SettleInput,
} from '@servicerouter/core';

import { createPaymentRepository } from './paymentRepository.js';
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from './postgres.js';
import { balances, keyDailySpend, keyTotalSpend, ledgerAccounts, ledgerEntries, ledgerTransactions } from './schema/ledger.js';
import { targetPayments } from './schema/routing.js';

/** The ledger accounts' IDs (LG-1): an account's own, and the platform's. */
export const ledgerAccountIds = {
  available: (accountId: string) => `${accountId}:available`,
  held: (accountId: string) => `${accountId}:held`,
  earned: (accountId: string) => `${accountId}:earned`,
  fees: 'platform:fees',
  depositsClearing: 'platform:deposits_clearing',
  // The on-chain money of one asset, such as `platform:treasury:base-usdc`
  treasury: (asset: string) => `platform:treasury:${asset}`,
  // What rebalancing cost: the USD lost between two assets (TR-4, TR-6)
  conversion: 'platform:conversion',
  // The fee on routed calls (RT-5), and what targets kept while buyers weren't charged (RT-9)
  routingFees: 'platform:routing_fees',
  routingLosses: 'platform:routing_losses',
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
  /**
   * Books a settled on-chain payment (x402, MPP): the asset's treasury → seller earned plus platform
   * fees (LG-4): feeBps's share plus the settling facilitator's flat fee (P-2), capped at the amount.
   * With the status change to `settled` in the same transaction. From `verified` or `settling`
   * (LG-8). A second settle moves nothing (LG-3). Clears the settle request.
   */
  settle(input: SettleInput): Promise<CaptureResult>;
  balance(accountId: string): Promise<CreditsBalance>;
  /**
   * Books a confirmed payout (PO-7): seller earned → the payout asset's treasury, once per payout ID.
   * Returns the transaction, and whether it moved money now.
   */
  payout(input: { readonly payoutId: string; readonly sellerAccountId: string; readonly amount: MicroUsd; readonly asset: string }): Promise<CreditResult>;
  /**
   * Books a rebalancing an operator did (TR-4): the treasury of one asset → another's, with the USD
   * lost between them as conversion cost (TR-6). Idempotent by reference.
   */
  treasuryTransfer(input: {
    readonly reference: string;
    readonly from: { readonly asset: string; readonly amount: MicroUsd };
    readonly to: { readonly asset: string; readonly amount: MicroUsd };
    readonly requestId?: string;
  }): Promise<CreditResult>;
  /**
   * A target kept the platform's payment, but the buyer wasn't charged (RT-9): routing losses → the
   * target asset's treasury, once per payment.
   */
  routingLoss(input: { readonly paymentId: string }): Promise<CreditResult>;
  /** Ledger accounts' balances by ID. An account never used is absent. */
  balancesOf(ledgerAccountIds: readonly string[]): Promise<ReadonlyMap<string, bigint>>;
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
const routingFees: LedgerAccount = { id: ledgerAccountIds.routingFees, accountId: undefined, type: 'routing_fees', mayGoNegative: false };
// An expense: its balance is minus what targets kept
const routingLosses: LedgerAccount = { id: ledgerAccountIds.routingLosses, accountId: undefined, type: 'routing_losses', mayGoNegative: true };
// Money enters and leaves the chain through it, so its balance can go either way
const treasuryOf = (asset: string): LedgerAccount => ({ id: ledgerAccountIds.treasury(asset), accountId: undefined, type: 'treasury', mayGoNegative: true });

/** The target leg of a routed payment (RT-11): the platform must have paid the target before the buyer is charged. */
const targetLeg = async (tx: DatabaseTransaction, paymentId: string, to: 'captured' | 'settled'): Promise<{ readonly asset: string; readonly amount: bigint }> => {
  const [target] = await tx.select({ asset: targetPayments.asset, amount: targetPayments.amount }).from(targetPayments).where(eq(targetPayments.paymentId, paymentId));
  if (!target)
    throw new InvalidPaymentStatusChangeError(paymentId, undefined, to);

  return target;
};
// Money enters through it, so its balance is minus everything deposited
const depositsClearing: LedgerAccount = { id: ledgerAccountIds.depositsClearing, accountId: undefined, type: 'deposits_clearing', mayGoNegative: true };

const isPlatformAccount = (ledgerAccountId: string): boolean => ledgerAccountId.startsWith('platform:');

/**
 * The one order every transaction updates balances in, so none deadlock: the platform's accounts
 * last, since every capture shares the fee row and holds it only until the commit, then by ID.
 */
const lockOrder = (left: Posting, right: Posting): number =>
  Number(isPlatformAccount(left.ledgerAccountId)) - Number(isPlatformAccount(right.ledgerAccountId))
  || (left.ledgerAccountId < right.ledgerAccountId ? -1 : left.ledgerAccountId > right.ledgerAccountId ? 1 : 0);

export const createLedger = ({ db, clock, ids }: LedgerOptions): Ledger => {
  // Ledger accounts known to exist, so a capture skips creating them. Kept only when the ledger runs
  // on the database itself: inside a caller's transaction a rollback could undo them.
  const known = db instanceof PgTransaction ? undefined : new Set<string>();

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

  // Adds to each balance in turn. The first account that would go below zero, or doesn't exist.
  const updateBalances = async (tx: DatabaseTransaction, postings: readonly Posting[], now: Date): Promise<string | undefined> => {
    for (const { ledgerAccountId, amount } of postings) {
      const updated = await tx.update(balances)
        .set({ balance: sql`${balances.balance} + ${amount}::bigint`, updatedAt: now })
        .where(and(eq(balances.ledgerAccountId, ledgerAccountId), sql`(${balances.mayGoNegative} or ${balances.balance} + ${amount}::bigint >= 0)`))
        .returning({ id: balances.ledgerAccountId });
      if (updated.length === 0)
        return ledgerAccountId;
    }

    return undefined;
  };

  /**
   * Posts the entries and updates the balances (LG-2) in `lockOrder`, so concurrent postings never
   * deadlock. The platform's balances, which every capture shares, are updated last, after the
   * entries, so their row locks are held only until the commit. Returns the first account that would
   * go below zero, or doesn't exist: the caller rolls back.
   */
  const post = async (tx: DatabaseTransaction, transactionId: string, postings: readonly Posting[], now: Date): Promise<string | undefined> => {
    const entries = postings.filter(posting => posting.amount !== 0n);
    if (entries.reduce((sum, posting) => sum + posting.amount, 0n) !== 0n)
      throw new Error('A ledger transaction\'s entries must sum to zero');

    const ordered = [...entries].sort(lockOrder);
    const refused = await updateBalances(tx, ordered.filter(posting => !isPlatformAccount(posting.ledgerAccountId)), now);
    if (refused !== undefined)
      return refused;
    if (entries.length > 0)
      await tx.insert(ledgerEntries).values(entries.map(posting => ({ id: ids.next(), transactionId, ...posting })));

    return updateBalances(tx, ordered.filter(posting => isPlatformAccount(posting.ledgerAccountId)), now);
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

  // A locked payment that must be a held credits payment
  const heldCredits = (paymentId: string, payment: Payment | undefined, to: 'captured' | 'released'): Payment & { readonly buyerAccountId: string } => {
    if (!payment || payment.status !== 'held' || payment.rail !== 'credits' || !payment.buyerAccountId)
      throw new InvalidPaymentStatusChangeError(paymentId, payment?.status, to);

    return payment as Payment & { readonly buyerAccountId: string };
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
          // One clock read: the day the spend counts on is the day of the payment's createdAt, which a
          // release gives the spend back to
          const now = clock.now();
          const payments = createPaymentRepository({ db: tx, clock: { now: () => new Date(now) } });
          const transactionId = await insertTransaction(tx, 'hold', payment.id, payment.requestId, now);
          if (!transactionId) {
            // The same hold again: the first one stands
            const existing = await payments.find(payment.id);
            if (!existing)
              throw new Error('A hold transaction exists without its payment');

            return { ok: true, payment: existing };
          }

          const { buyerAccountId, keyId, amount } = payment;
          // The row first, which locks nothing that others update (PR-10)
          const created = await payments.create({ ...payment, status: 'held' });
          // Balance, then today's spend, then the total: every hold locks rows in the same order
          if (await post(tx, transactionId, [
            { ledgerAccountId: ledgerAccountIds.available(buyerAccountId), amount: -amount },
            { ledgerAccountId: ledgerAccountIds.held(buyerAccountId), amount },
          ], now))
            throw new HoldRefused('insufficient_balance');
          const refusal = await addSpend(tx, keyId, utcDay(now), amount, dailyBudget, allowance);
          if (refusal)
            throw new HoldRefused(refusal);

          return { ok: true, payment: created };
        });
      }
      catch (error) {
        if (error instanceof HoldRefused)
          return { ok: false, refusal: error.refusal };
        throw error;
      }
    },

    capture: async ({ paymentId, feeBps }) => {
      let created: readonly LedgerAccount[] = [];
      const result = await withTransaction(db, async (tx): Promise<CaptureResult> => {
        const payments = createPaymentRepository({ db: tx, clock });
        const current = await payments.lock(paymentId);
        // A second capture moves nothing (LG-3)
        if (current?.status === 'captured')
          return { payment: current, fee: current.fee ?? 0n, sellerAmount: current.amount - (current.fee ?? 0n) };

        const payment = heldCredits(paymentId, current, 'captured');
        const now = clock.now();
        // A routed call: the quote goes to the treasury the target was paid from, and the rest is the routing fee (RT-5)
        if (payment.kind === 'routed') {
          const target = await targetLeg(tx, paymentId, 'captured');
          const fee = payment.amount - target.amount;
          created = [routingFees, treasuryOf(target.asset)].filter(account => !known?.has(account.id));
          if (created.length > 0)
            await ensureAccounts(tx, created, now);
          const transactionId = await insertTransaction(tx, 'capture', paymentId, payment.requestId, now);
          if (!transactionId)
            throw new Error('A capture transaction exists for a payment still held');
          const captured = await payments.changeStatus({ paymentId, to: 'captured', fee });
          if (await post(tx, transactionId, [
            { ledgerAccountId: ledgerAccountIds.held(payment.buyerAccountId), amount: -payment.amount },
            { ledgerAccountId: ledgerAccountIds.treasury(target.asset), amount: target.amount },
            { ledgerAccountId: routingFees.id, amount: fee },
          ], now))
            throw new Error('The held amount is missing from the buyer\'s held balance');

          return { payment: captured, fee, sellerAmount: 0n };
        }
        if (!payment.sellerAccountId)
          throw new InvalidPaymentStatusChangeError(paymentId, payment.status, 'captured');

        const { fee, sellerAmount } = splitFee(payment.amount, feeBps);
        created = [...accountsOf(payment.sellerAccountId, 'earned'), platformFees].filter(account => !known?.has(account.id));
        if (created.length > 0)
          await ensureAccounts(tx, created, now);
        const transactionId = await insertTransaction(tx, 'capture', paymentId, payment.requestId, now);
        if (!transactionId)
          throw new Error('A capture transaction exists for a payment still held');
        // The status first, on the row already locked; the balances, and the shared fee row, last
        const captured = await payments.changeStatus({ paymentId, to: 'captured', fee });
        if (await post(tx, transactionId, [
          { ledgerAccountId: ledgerAccountIds.held(payment.buyerAccountId), amount: -payment.amount },
          { ledgerAccountId: ledgerAccountIds.earned(payment.sellerAccountId), amount: sellerAmount },
          { ledgerAccountId: platformFees.id, amount: fee },
        ], now))
          throw new Error('The held amount is missing from the buyer\'s held balance');

        return { payment: captured, fee, sellerAmount };
      });
      // Committed: they exist from now on
      for (const account of created)
        known?.add(account.id);

      return result;
    },

    settle: async ({ paymentId, feeBps, feePerPayment = 0n, asset, transactionHash, receipt, needsReview }) => {
      let created: readonly LedgerAccount[] = [];
      const result = await withTransaction(db, async (tx): Promise<CaptureResult> => {
        const payments = createPaymentRepository({ db: tx, clock });
        const current = await payments.lock(paymentId);
        // A second settle moves nothing (LG-3)
        if (current?.status === 'settled')
          return { payment: current, fee: current.fee ?? 0n, sellerAmount: current.amount - (current.fee ?? 0n) };
        if (!current || (current.status !== 'verified' && current.status !== 'settling') || current.rail === 'credits')
          throw new InvalidPaymentStatusChangeError(paymentId, current?.status, 'settled');

        const now = clock.now();
        // A routed call: the buyer's asset's treasury → the target asset's, and the routing fee (RT-5)
        if (current.kind === 'routed') {
          const target = await targetLeg(tx, paymentId, 'settled');
          const fee = current.amount - target.amount;
          const inflow = treasuryOf(asset);
          created = [routingFees, inflow, treasuryOf(target.asset)].filter(account => !known?.has(account.id));
          if (created.length > 0)
            await ensureAccounts(tx, created, now);
          const transactionId = await insertTransaction(tx, 'settle', paymentId, current.requestId, now);
          if (!transactionId)
            throw new Error('A settle transaction exists for a payment not settled');
          const settled = await payments.changeStatus({
            paymentId, to: 'settled', fee, needsReview, settlementRequest: null,
            ...(transactionHash === undefined ? {} : { transactionHash }),
            ...(receipt === undefined ? {} : { receipt }),
          });
          await post(tx, transactionId, [
            { ledgerAccountId: inflow.id, amount: -current.amount },
            { ledgerAccountId: ledgerAccountIds.treasury(target.asset), amount: target.amount },
            { ledgerAccountId: routingFees.id, amount: fee },
          ], now);

          return { payment: settled, fee, sellerAmount: 0n };
        }
        if (!current.sellerAccountId)
          throw new InvalidPaymentStatusChangeError(paymentId, current.status, 'settled');

        // feeBps's share plus the settling facilitator's flat fee, never more than the amount (LG-4, P-2)
        const { fee, sellerAmount } = splitFee(current.amount, feeBps, feePerPayment);
        // Money arrives on chain, outside the ledger, so the treasury's balance is minus what it took in
        const treasury: LedgerAccount = { id: ledgerAccountIds.treasury(asset), accountId: undefined, type: 'treasury', mayGoNegative: true };
        created = [...accountsOf(current.sellerAccountId, 'earned'), platformFees, treasury].filter(account => !known?.has(account.id));
        if (created.length > 0)
          await ensureAccounts(tx, created, now);
        const transactionId = await insertTransaction(tx, 'settle', paymentId, current.requestId, now);
        if (!transactionId)
          throw new Error('A settle transaction exists for a payment not settled');
        const settled = await payments.changeStatus({
          paymentId,
          to: 'settled',
          fee,
          needsReview,
          settlementRequest: null,
          ...(transactionHash === undefined ? {} : { transactionHash }),
          ...(receipt === undefined ? {} : { receipt }),
        });
        await post(tx, transactionId, [
          { ledgerAccountId: treasury.id, amount: -current.amount },
          { ledgerAccountId: ledgerAccountIds.earned(current.sellerAccountId), amount: sellerAmount },
          { ledgerAccountId: platformFees.id, amount: fee },
        ], now);

        return { payment: settled, fee, sellerAmount };
      });
      for (const account of created)
        known?.add(account.id);

      return result;
    },

    routingLoss: ({ paymentId }) => withTransaction(db, async tx => {
      const now = clock.now();
      const [target] = await tx.select().from(targetPayments).where(eq(targetPayments.paymentId, paymentId)).for('update');
      if (!target)
        throw new Error(`No target payment for ${paymentId}`);
      await ensureAccounts(tx, [routingLosses, treasuryOf(target.asset)], now);
      const transactionId = await insertTransaction(tx, 'routing_loss', paymentId, undefined, now);
      if (!transactionId) {
        const [existing] = await tx.select({ id: ledgerTransactions.id, createdAt: ledgerTransactions.createdAt }).from(ledgerTransactions)
          .where(and(eq(ledgerTransactions.operation, 'routing_loss'), eq(ledgerTransactions.reference, paymentId)));

        return { transactionId: existing!.id, createdAt: existing!.createdAt, replayed: true };
      }
      await post(tx, transactionId, [
        { ledgerAccountId: routingLosses.id, amount: -target.amount },
        { ledgerAccountId: ledgerAccountIds.treasury(target.asset), amount: target.amount },
      ], now);
      await tx.update(targetPayments).set({ lossBooked: true, updatedAt: now }).where(eq(targetPayments.paymentId, paymentId));

      return { transactionId, createdAt: now, replayed: false };
    }),

    payout: ({ payoutId, sellerAccountId, amount, asset }) => withTransaction(db, async tx => {
      if (amount <= 0n)
        throw new RangeError('A payout must be more than zero');
      const now = clock.now();
      const treasury: LedgerAccount = { id: ledgerAccountIds.treasury(asset), accountId: undefined, type: 'treasury', mayGoNegative: true };
      await ensureAccounts(tx, [...accountsOf(sellerAccountId, 'earned'), treasury], now);
      const transactionId = await insertTransaction(tx, 'payout', payoutId, undefined, now);
      if (!transactionId) {
        const [existing] = await tx.select({ id: ledgerTransactions.id, createdAt: ledgerTransactions.createdAt }).from(ledgerTransactions)
          .where(and(eq(ledgerTransactions.operation, 'payout'), eq(ledgerTransactions.reference, payoutId)));

        return { transactionId: existing!.id, createdAt: existing!.createdAt, replayed: true };
      }
      // Earned can't go below zero: a payout never pays more than was earned
      const refused = await post(tx, transactionId, [
        { ledgerAccountId: ledgerAccountIds.earned(sellerAccountId), amount: -amount },
        { ledgerAccountId: treasury.id, amount },
      ], now);
      if (refused !== undefined)
        throw new Error(`A payout would take ${refused} below zero`);

      return { transactionId, createdAt: now, replayed: false };
    }),

    treasuryTransfer: ({ reference, from, to, requestId }) => withTransaction(db, async tx => {
      if (from.amount <= 0n || to.amount <= 0n)
        throw new RangeError('A treasury transfer moves more than zero');
      if (to.amount > from.amount)
        throw new RangeError('A treasury transfer can\'t gain USD: the platform absorbs conversion costs (TR-6)');
      const now = clock.now();
      const accounts: LedgerAccount[] = [
        { id: ledgerAccountIds.treasury(from.asset), accountId: undefined, type: 'treasury', mayGoNegative: true },
        { id: ledgerAccountIds.treasury(to.asset), accountId: undefined, type: 'treasury', mayGoNegative: true },
        { id: ledgerAccountIds.conversion, accountId: undefined, type: 'conversion', mayGoNegative: true },
      ];
      await ensureAccounts(tx, accounts, now);
      const transactionId = await insertTransaction(tx, 'treasury_transfer', reference, requestId, now);
      if (!transactionId) {
        const [existing] = await tx.select({ id: ledgerTransactions.id, createdAt: ledgerTransactions.createdAt }).from(ledgerTransactions)
          .where(and(eq(ledgerTransactions.operation, 'treasury_transfer'), eq(ledgerTransactions.reference, reference)));

        return { transactionId: existing!.id, createdAt: existing!.createdAt, replayed: true };
      }
      // The source treasury holds less, the target more, and the difference is the conversion cost
      await post(tx, transactionId, [
        { ledgerAccountId: ledgerAccountIds.treasury(from.asset), amount: from.amount },
        { ledgerAccountId: ledgerAccountIds.treasury(to.asset), amount: -to.amount },
        { ledgerAccountId: ledgerAccountIds.conversion, amount: to.amount - from.amount },
      ], now);

      return { transactionId, createdAt: now, replayed: false };
    }),

    balancesOf: async ids => {
      if (ids.length === 0)
        return new Map();
      const rows = await db.select({ id: balances.ledgerAccountId, balance: balances.balance }).from(balances).where(inArray(balances.ledgerAccountId, [...ids]));

      return new Map(rows.map(row => [row.id, row.balance]));
    },

    release: ({ paymentId }) => withTransaction(db, async tx => {
      const payments = createPaymentRepository({ db: tx, clock });
      const current = await payments.lock(paymentId);
      // A second release moves nothing (LG-3)
      if (current?.status === 'released')
        return { payment: current };

      const payment = heldCredits(paymentId, current, 'released');
      const buyer = payment.buyerAccountId;
      const now = clock.now();
      const transactionId = await insertTransaction(tx, 'release', paymentId, payment.requestId, now);
      if (!transactionId)
        throw new Error('A release transaction exists for a payment still held');
      const released = await payments.changeStatus({ paymentId, to: 'released' });
      if (await post(tx, transactionId, [
        { ledgerAccountId: ledgerAccountIds.held(buyer), amount: -payment.amount },
        { ledgerAccountId: ledgerAccountIds.available(buyer), amount: payment.amount },
      ], now))
        throw new Error('The held amount is missing from the buyer\'s held balance');
      // The spend goes back to the day it was counted on
      if (payment.keyId)
        await giveBackSpend(tx, payment.keyId, utcDay(payment.createdAt), payment.amount);

      return { payment: released };
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
