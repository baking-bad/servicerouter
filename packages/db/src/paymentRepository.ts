import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';

import type { Clock } from '@servicerouter/common';
import {
  InvalidPaymentStatusChangeError, PaymentFinalizedError, statusesBefore, type BillingDecision, type InitialPaymentStatus, type JsonObject,
  type NewPayment, type Payment, type PaymentPage, type PaymentStatus, type RailName, type ServiceEarnings,
} from '@servicerouter/core';

import type { DatabaseExecutor } from './postgres.js';
import { payments } from './schema/ledger.js';

export interface PaymentRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
  readonly clock: Clock;
}

export interface StatusChange {
  readonly paymentId: string;
  readonly to: PaymentStatus;
  readonly fee?: bigint;
  readonly transactionHash?: string;
  readonly receipt?: string;
  readonly needsReview?: boolean;
  // The settle request to repeat while `settling` (PR-12, WK-6). Null clears it, as a final status should.
  readonly settlementRequest?: JsonObject | null;
}

/** A payment still `settling`, with the settle request that a follow-up repeats as it was (WK-6). */
export interface SettlingPayment {
  readonly payment: Payment;
  readonly settlementRequest: JsonObject | undefined;
}

/** The `payments` rows (LG-7, LG-8). Implements the rails' PaymentRecorder port (PR-10). */
export interface PaymentRepository {
  create(payment: NewPayment & { readonly status: InitialPaymentStatus; readonly transactionHash?: string }): Promise<Payment>;
  recordDecision(input: {
    readonly paymentId: string;
    readonly decision: BillingDecision;
    readonly upstreamStatus: number | undefined;
    readonly upstreamLatencyMs: number | undefined;
  }): Promise<Payment>;
  /** Throws InvalidPaymentStatusChangeError unless LG-8 allows the change from the current status. */
  changeStatus(change: StatusChange): Promise<Payment>;
  find(paymentId: string): Promise<Payment | undefined>;
  /** Reads the payment and locks its row until the transaction ends. */
  lock(paymentId: string): Promise<Payment | undefined>;
  /** A buyer's payments, newest first. `after` is the `next` of the previous page. */
  listForBuyer(input: { readonly buyerAccountId: string; readonly limit: number; readonly after?: string }): Promise<PaymentPage>;
  /** A service's earnings from captured and settled payments (LG-10). */
  earnings(serviceId: string): Promise<ServiceEarnings>;
  /**
   * Payments still `held` that were created before `createdBefore`, oldest first: the holds a crash
   * left behind (LG-9). `after` is the last payment of the previous page.
   */
  listExpiredHolds(input: {
    readonly createdBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly id: string };
  }): Promise<readonly Payment[]>;
  /** Payments still `settling`, oldest first, with their settle requests (WK-6). `after` is the last of the previous page. */
  listSettling(input: { readonly limit: number; readonly after?: { readonly createdAt: Date; readonly id: string } }): Promise<readonly SettlingPayment[]>;
}

const optional = <TValue>(value: TValue | null): TValue | undefined => value ?? undefined;

const toPayment = (row: typeof payments.$inferSelect): Payment => ({
  id: row.id,
  requestId: optional(row.requestId),
  kind: row.kind,
  rail: row.rail,
  buyerAccountId: optional(row.buyerAccountId),
  keyId: optional(row.keyId),
  sellerAccountId: optional(row.sellerAccountId),
  serviceId: optional(row.serviceId),
  routeKey: optional(row.routeKey),
  targetHost: optional(row.targetHost),
  targetPath: optional(row.targetPath),
  network: optional(row.network),
  asset: optional(row.asset),
  atomicAmount: optional(row.atomicAmount),
  amount: row.amount,
  status: row.status,
  fee: optional(row.fee),
  decision: optional(row.decision),
  upstreamStatus: optional(row.upstreamStatus),
  upstreamLatencyMs: optional(row.upstreamLatencyMs),
  transactionHash: optional(row.transactionHash),
  receipt: optional(row.receipt),
  needsReview: row.needsReview,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

// The page cursor: the last payment's time and ID, so payments made in the same millisecond keep their order
const encodeCursor = (payment: Payment): string => Buffer.from(`${payment.createdAt.toISOString()}|${payment.id}`).toString('base64url');
const decodeCursor = (cursor: string): { readonly createdAt: Date; readonly id: string } | undefined => {
  const [time = '', id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(time);

  return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : undefined;
};

const earningStatuses: readonly PaymentStatus[] = ['captured', 'settled'];

export const createPaymentRepository = ({ db, clock }: PaymentRepositoryOptions): PaymentRepository => {
  const find = async (paymentId: string): Promise<Payment | undefined> => {
    const [row] = await db.select().from(payments).where(eq(payments.id, paymentId));

    return row ? toPayment(row) : undefined;
  };

  return {
    create: async payment => {
      const now = clock.now();
      const [row] = await db.insert(payments).values({
        id: payment.id,
        requestId: payment.requestId ?? null,
        kind: payment.kind,
        rail: payment.rail,
        buyerAccountId: payment.buyerAccountId ?? null,
        keyId: payment.keyId ?? null,
        sellerAccountId: payment.sellerAccountId ?? null,
        serviceId: payment.serviceId ?? null,
        routeKey: payment.routeKey ?? null,
        targetHost: payment.targetHost ?? null,
        targetPath: payment.targetPath ?? null,
        network: payment.network ?? null,
        asset: payment.asset ?? null,
        atomicAmount: payment.atomicAmount ?? null,
        amount: payment.amount,
        status: payment.status,
        transactionHash: payment.transactionHash ?? null,
        needsReview: false,
        createdAt: now,
        updatedAt: now,
      }).returning();

      return toPayment(row!);
    },
    recordDecision: async ({ paymentId, decision, upstreamStatus, upstreamLatencyMs }) => {
      // Only while the payment can still be finalized: a decision never changes a finished payment
      const [row] = await db.update(payments)
        .set({ decision, upstreamStatus: upstreamStatus ?? null, upstreamLatencyMs: upstreamLatencyMs ?? null, updatedAt: clock.now() })
        .where(and(eq(payments.id, paymentId), inArray(payments.status, ['held', 'verified'])))
        .returning();
      if (!row)
        throw new PaymentFinalizedError(paymentId, (await find(paymentId))?.status);


      return toPayment(row);
    },
    changeStatus: async ({ paymentId, to, fee, transactionHash, receipt, needsReview, settlementRequest }) => {
      const [row] = await db.update(payments)
        .set({
          status: to,
          updatedAt: clock.now(),
          ...(fee === undefined ? {} : { fee }),
          ...(transactionHash === undefined ? {} : { transactionHash }),
          ...(receipt === undefined ? {} : { receipt }),
          ...(needsReview === undefined ? {} : { needsReview }),
          ...(settlementRequest === undefined ? {} : { settlementRequest }),
        })
        // LG-8: only from a status the change is allowed from, checked and written in one statement
        .where(and(eq(payments.id, paymentId), inArray(payments.status, [...statusesBefore(to)])))
        .returning();
      if (!row)
        throw new InvalidPaymentStatusChangeError(paymentId, (await find(paymentId))?.status, to);

      return toPayment(row);
    },
    find,
    lock: async paymentId => {
      const [row] = await db.select().from(payments).where(eq(payments.id, paymentId)).for('update');

      return row ? toPayment(row) : undefined;
    },
    listForBuyer: async ({ buyerAccountId, limit, after }) => {
      const cursor = after === undefined ? undefined : decodeCursor(after);
      const rows = await db.select().from(payments)
        .where(and(
          eq(payments.buyerAccountId, buyerAccountId),
          cursor && or(lt(payments.createdAt, cursor.createdAt), and(eq(payments.createdAt, cursor.createdAt), lt(payments.id, cursor.id))),
        ))
        .orderBy(desc(payments.createdAt), desc(payments.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit).map(toPayment);

      return { payments: page, next: rows.length > limit ? encodeCursor(page.at(-1)!) : undefined };
    },
    earnings: async serviceId => {
      const rows = await db.select({
        rail: payments.rail,
        calls: sql<number>`count(*)::int`,
        earned: sql<string>`coalesce(sum(${payments.amount} - coalesce(${payments.fee}, 0)), 0)::text`,
        fee: sql<string>`coalesce(sum(${payments.fee}), 0)::text`,
      }).from(payments)
        .where(and(eq(payments.serviceId, serviceId), inArray(payments.status, [...earningStatuses])))
        .groupBy(payments.rail);
      const earnedByRail: Partial<Record<RailName, bigint>> = {};
      let earned = 0n;
      let fee = 0n;
      let calls = 0;
      for (const row of rows) {
        earnedByRail[row.rail] = BigInt(row.earned);
        earned += BigInt(row.earned);
        fee += BigInt(row.fee);
        calls += row.calls;
      }

      return { calls, earnedByRail, earned, fee, paidOut: 0n };
    },
    listExpiredHolds: async ({ createdBefore, limit, after }) => {
      const rows = await db.select().from(payments)
        .where(and(
          eq(payments.status, 'held'),
          lt(payments.createdAt, createdBefore),
          after && or(gt(payments.createdAt, after.createdAt), and(eq(payments.createdAt, after.createdAt), gt(payments.id, after.id))),
        ))
        .orderBy(asc(payments.createdAt), asc(payments.id))
        .limit(limit);

      return rows.map(toPayment);
    },
    listSettling: async ({ limit, after }) => {
      const rows = await db.select().from(payments)
        .where(and(
          eq(payments.status, 'settling'),
          after && or(gt(payments.createdAt, after.createdAt), and(eq(payments.createdAt, after.createdAt), gt(payments.id, after.id))),
        ))
        .orderBy(asc(payments.createdAt), asc(payments.id))
        .limit(limit);

      return rows.map(row => ({ payment: toPayment(row), settlementRequest: row.settlementRequest ?? undefined }));
    },
  };
};
