import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Clock, IdGenerator, MicroUsd } from '@servicerouter/common';

import { createLedger } from './ledgerRepository.js';
import { withTransaction, type DatabaseExecutor } from './postgres.js';
import { payments } from './schema/ledger.js';
import {
  payoutItems, payoutRuns, payouts, payoutTransactions, type PayoutRunStatus, type PayoutStatus, type PayoutTransactionStatus,
} from './schema/payouts.js';
import { serviceRevisions, services } from './schema/services.js';

export interface PayoutRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** What a service owes at a cutoff, with its active revision's payout address and asset (PO-1, PO-2). */
export interface ServiceDueRow {
  readonly serviceId: string;
  readonly sellerAccountId: string;
  readonly address: string;
  readonly asset: string;
  readonly amount: MicroUsd;
}

export interface PayoutRunRecord {
  readonly id: string;
  readonly cutoff: Date;
  readonly status: PayoutRunStatus;
  readonly asset: string;
  readonly total: MicroUsd;
  readonly problem: string | undefined;
  readonly approvedAt: Date | undefined;
  readonly approvedBy: string | undefined;
}

export interface PayoutTransactionRecord {
  readonly runId: string;
  readonly index: number;
  readonly txHash: string;
  readonly cbor: string;
  readonly validUntil: Date;
  readonly status: PayoutTransactionStatus;
  readonly submittedAt: Date | undefined;
}

export interface PayoutRecord {
  readonly id: string;
  readonly sellerAccountId: string;
  readonly address: string;
  readonly amount: MicroUsd;
  readonly quantity: bigint;
  readonly transactionIndex: number;
  readonly status: PayoutStatus;
}

export interface NewPayoutRun {
  readonly id: string;
  readonly cutoff: Date;
  readonly status: Extract<PayoutRunStatus, 'awaiting_approval' | 'approved' | 'empty'>;
  readonly asset: string;
  readonly payouts: readonly (Omit<PayoutRecord, 'status'> & { readonly items: readonly { readonly serviceId: string; readonly amount: MicroUsd }[] })[];
  readonly transactions: readonly Pick<PayoutTransactionRecord, 'index' | 'txHash' | 'cbor' | 'validUntil'>[];
}

/** The `payout_runs`, `payout_transactions`, `payouts`, and `payout_items` tables (Payouts). */
export interface PayoutRepository {
  /** What each service owes at the cutoff: net earnings booked before it, minus payouts not failed (PO-1). */
  serviceDues(cutoff: Date): Promise<readonly ServiceDueRow[]>;
  findRun(id: string): Promise<PayoutRunRecord | undefined>;
  runsWithStatus(statuses: readonly PayoutRunStatus[]): Promise<readonly PayoutRunRecord[]>;
  /**
   * Stores a built run. A run that exists is replaced only while nothing of it was submitted: stopped,
   * empty, or waiting for an approval that expired. Returns whether it stored it.
   */
  saveRun(run: NewPayoutRun): Promise<boolean>;
  /** Records that a run couldn't be built, such as when the wallet doesn't cover it (PO-5). */
  stopRun(input: { readonly id: string; readonly cutoff: Date; readonly asset: string; readonly problem: string }): Promise<void>;
  /** An operator approves a waiting run (PO-6). Returns the run, or undefined unless it was waiting. */
  approve(input: { readonly id: string; readonly by: string }): Promise<PayoutRunRecord | undefined>;
  transactions(runId: string): Promise<readonly PayoutTransactionRecord[]>;
  payoutsOf(runId: string): Promise<readonly PayoutRecord[]>;
  markSubmitted(runId: string, index: number): Promise<void>;
  /** Books each payout of the transaction in the ledger, once (PO-7), and marks them confirmed. */
  confirmTransaction(input: { readonly runId: string; readonly index: number; readonly asset: string }): Promise<void>;
  /** The transaction can't land: its payouts fail, and their earnings wait for the next run (PO-7). */
  failTransaction(runId: string, index: number): Promise<void>;
  setRunStatus(id: string, status: PayoutRunStatus, problem?: string): Promise<void>;
  /** Paid out per service: confirmed payouts, and pending ones (LG-10). */
  paidOut(serviceId: string): Promise<{ readonly confirmed: MicroUsd; readonly pending: MicroUsd }>;
}

const toRun = (row: typeof payoutRuns.$inferSelect): PayoutRunRecord => ({
  id: row.id,
  cutoff: row.cutoff,
  status: row.status,
  asset: row.asset,
  total: row.total as MicroUsd,
  problem: row.problem ?? undefined,
  approvedAt: row.approvedAt ?? undefined,
  approvedBy: row.approvedBy ?? undefined,
});

const toTransaction = (row: typeof payoutTransactions.$inferSelect): PayoutTransactionRecord => ({
  runId: row.runId,
  index: row.index,
  txHash: row.txHash,
  cbor: row.cbor,
  validUntil: row.validUntil,
  status: row.status,
  submittedAt: row.submittedAt ?? undefined,
});

const toPayout = (row: typeof payouts.$inferSelect): PayoutRecord => ({
  id: row.id,
  sellerAccountId: row.sellerAccountId,
  address: row.address,
  amount: row.amount as MicroUsd,
  quantity: row.quantity,
  transactionIndex: row.transactionIndex,
  status: row.status,
});

// A run may be built again only while nothing of it went out
const rebuildable: readonly PayoutRunStatus[] = ['stopped', 'empty', 'awaiting_approval'];

export const createPayoutRepository = ({ db, clock, ids }: PayoutRepositoryOptions): PayoutRepository => {
  const deleteChildren = async (tx: DatabaseExecutor, runId: string): Promise<void> => {
    const ids = (await tx.select({ id: payouts.id }).from(payouts).where(eq(payouts.runId, runId))).map(row => row.id);
    if (ids.length > 0)
      await tx.delete(payoutItems).where(inArray(payoutItems.payoutId, ids));
    await tx.delete(payouts).where(eq(payouts.runId, runId));
    await tx.delete(payoutTransactions).where(eq(payoutTransactions.runId, runId));
  };

  return {
    serviceDues: async cutoff => {
      const rows = await db.execute<{ service_id: string; seller_account_id: string; address: string | null; asset: string | null; due: string }>(sql`
        with earned as (
          select ${payments.serviceId} as service_id, sum(${payments.amount} - coalesce(${payments.fee}, 0)) as net
          from ${payments}
          where ${payments.kind} = 'service' and ${payments.status} in ('captured', 'settled') and ${payments.updatedAt} < ${cutoff}
          group by 1
        ), paid as (
          select ${payoutItems.serviceId} as service_id, sum(${payoutItems.amount}) as paid
          from ${payoutItems} join ${payouts} on ${payouts.id} = ${payoutItems.payoutId}
          where ${payouts.status} <> 'failed'
          group by 1
        )
        select ${services.id} as service_id, ${services.ownerAccountId} as seller_account_id,
          ${serviceRevisions.config} -> 'payouts' -> 'default' ->> 'address' as address,
          ${serviceRevisions.config} -> 'payouts' -> 'default' ->> 'asset' as asset,
          (earned.net - coalesce(paid.paid, 0))::text as due
        from earned
        join ${services} on ${services.id} = earned.service_id
        join ${serviceRevisions} on ${serviceRevisions.serviceId} = ${services.id} and ${serviceRevisions.number} = ${services.activeRevision}
        left join paid on paid.service_id = earned.service_id
        order by 1`);

      return rows.rows
        .filter(row => row.address !== null && row.asset !== null)
        .map(row => ({ serviceId: row.service_id, sellerAccountId: row.seller_account_id, address: row.address!, asset: row.asset!, amount: BigInt(row.due) as MicroUsd }));
    },

    findRun: async id => {
      const [row] = await db.select().from(payoutRuns).where(eq(payoutRuns.id, id));

      return row ? toRun(row) : undefined;
    },

    runsWithStatus: async statuses => (await db.select().from(payoutRuns)
      .where(inArray(payoutRuns.status, [...statuses])).orderBy(asc(payoutRuns.cutoff))).map(toRun),

    saveRun: run => withTransaction(db, async tx => {
      const now = clock.now();
      const total = run.payouts.reduce((sum, payout) => sum + payout.amount, 0n);
      const [existing] = await tx.select().from(payoutRuns).where(eq(payoutRuns.id, run.id)).for('update');
      if (existing && !rebuildable.includes(existing.status))
        return false;

      if (existing) {
        await deleteChildren(tx, run.id);
        await tx.update(payoutRuns).set({ status: run.status, asset: run.asset, total, problem: null, updatedAt: now, approvedAt: null, approvedBy: null })
          .where(eq(payoutRuns.id, run.id));
      }
      else
        await tx.insert(payoutRuns).values({ id: run.id, cutoff: run.cutoff, status: run.status, asset: run.asset, total, createdAt: now, updatedAt: now });

      if (run.transactions.length > 0)
        await tx.insert(payoutTransactions).values(run.transactions.map(transaction => ({ runId: run.id, ...transaction, status: 'built' as const })));
      for (const payout of run.payouts) {
        await tx.insert(payouts).values({
          id: payout.id, runId: run.id, sellerAccountId: payout.sellerAccountId, address: payout.address, amount: payout.amount,
          quantity: payout.quantity, transactionIndex: payout.transactionIndex, status: 'pending', createdAt: now,
        });
        await tx.insert(payoutItems).values(payout.items.map(item => ({ payoutId: payout.id, serviceId: item.serviceId, amount: item.amount })));
      }

      return true;
    }),

    stopRun: async ({ id, cutoff, asset, problem }) => {
      const now = clock.now();
      await withTransaction(db, async tx => {
        const [existing] = await tx.select().from(payoutRuns).where(eq(payoutRuns.id, id)).for('update');
        if (existing && !rebuildable.includes(existing.status))
          return;
        if (existing) {
          await deleteChildren(tx, id);
          await tx.update(payoutRuns).set({ status: 'stopped', total: 0n, problem, updatedAt: now }).where(eq(payoutRuns.id, id));
        }
        else
          await tx.insert(payoutRuns).values({ id, cutoff, status: 'stopped', asset, total: 0n, problem, createdAt: now, updatedAt: now });
      });
    },

    approve: async ({ id, by }) => {
      const now = clock.now();
      const [row] = await db.update(payoutRuns).set({ status: 'approved', approvedAt: now, approvedBy: by, updatedAt: now })
        .where(and(eq(payoutRuns.id, id), eq(payoutRuns.status, 'awaiting_approval')))
        .returning();

      return row ? toRun(row) : undefined;
    },

    transactions: async runId => (await db.select().from(payoutTransactions)
      .where(eq(payoutTransactions.runId, runId)).orderBy(asc(payoutTransactions.index))).map(toTransaction),

    payoutsOf: async runId => (await db.select().from(payouts).where(eq(payouts.runId, runId)).orderBy(asc(payouts.id))).map(toPayout),

    markSubmitted: async (runId, index) => {
      await db.update(payoutTransactions).set({ status: 'submitted', submittedAt: clock.now() })
        .where(and(eq(payoutTransactions.runId, runId), eq(payoutTransactions.index, index), eq(payoutTransactions.status, 'built')));
    },

    confirmTransaction: ({ runId, index, asset }) => withTransaction(db, async tx => {
      const now = clock.now();
      const [transaction] = await tx.select().from(payoutTransactions)
        .where(and(eq(payoutTransactions.runId, runId), eq(payoutTransactions.index, index))).for('update');
      if (!transaction || transaction.status === 'confirmed')
        return;

      const ledger = createLedger({ db: tx, clock, ids });
      const pending = await tx.select().from(payouts)
        .where(and(eq(payouts.runId, runId), eq(payouts.transactionIndex, index), eq(payouts.status, 'pending')));
      for (const payout of pending) {
        // Seller earned → the payout asset's treasury, once per payout (PO-7, LG-3)
        const booked = await ledger.payout({ payoutId: payout.id, sellerAccountId: payout.sellerAccountId, amount: payout.amount as MicroUsd, asset });
        await tx.update(payouts).set({ status: 'confirmed', ledgerTransactionId: booked.transactionId, confirmedAt: now }).where(eq(payouts.id, payout.id));
      }
      await tx.update(payoutTransactions).set({ status: 'confirmed', finishedAt: now })
        .where(and(eq(payoutTransactions.runId, runId), eq(payoutTransactions.index, index)));
    }),

    failTransaction: (runId, index) => withTransaction(db, async tx => {
      const now = clock.now();
      await tx.update(payouts).set({ status: 'failed' })
        .where(and(eq(payouts.runId, runId), eq(payouts.transactionIndex, index), eq(payouts.status, 'pending')));
      await tx.update(payoutTransactions).set({ status: 'failed', finishedAt: now })
        .where(and(eq(payoutTransactions.runId, runId), eq(payoutTransactions.index, index), inArray(payoutTransactions.status, ['built', 'submitted'])));
    }),

    setRunStatus: async (id, status, problem) => {
      await db.update(payoutRuns).set({ status, updatedAt: clock.now(), ...(problem === undefined ? {} : { problem }) }).where(eq(payoutRuns.id, id));
    },

    paidOut: async serviceId => {
      const [row] = await db.select({
        confirmed: sql<string>`coalesce(sum(${payoutItems.amount}) filter (where ${payouts.status} = 'confirmed'), 0)::text`,
        pending: sql<string>`coalesce(sum(${payoutItems.amount}) filter (where ${payouts.status} = 'pending'), 0)::text`,
      }).from(payoutItems).innerJoin(payouts, eq(payouts.id, payoutItems.payoutId)).where(eq(payoutItems.serviceId, serviceId));

      return { confirmed: BigInt(row?.confirmed ?? '0') as MicroUsd, pending: BigInt(row?.pending ?? '0') as MicroUsd };
    },
  };
};
