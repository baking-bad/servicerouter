import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';

import type { Clock } from '@servicerouter/common';
import type { PaymentStatus } from '@servicerouter/core';

import type { DatabaseExecutor } from './postgres.js';
import { payments } from './schema/ledger.js';
import { hostBlocklist, routedEndpoints, signatures, targetPayments, type TargetPaymentStatus } from './schema/routing.js';
import { services } from './schema/services.js';

// AR17: at most this many routed endpoints per host
export const maxRoutedEndpointsPerHost = 1_000;

export type EndpointRegistration = 'created' | 'exists' | 'capped' | 'service_host';

export interface NewTargetPayment {
  readonly paymentId: string;
  readonly protocol: 'x402' | 'mpp';
  readonly network: string;
  readonly asset: string;
  readonly amount: bigint;
  readonly atomicAmount: bigint;
  readonly payTo: string;
  readonly signatureId: string;
}

export type TargetPaymentRecord = typeof targetPayments.$inferSelect;

/** A routed call whose target kept our payment while its buyer paid nothing (RT-9). */
export interface UnbookedRoutingLoss {
  readonly paymentId: string;
  // What the target was paid, in micro-USD
  readonly amount: bigint;
  readonly asset: string;
  readonly targetHost: string | null;
  readonly buyerStatus: PaymentStatus;
}

// The buyer's payment ended without charging them
const unchargedStatuses = ['failed', 'released', 'cancelled'] as const satisfies readonly PaymentStatus[];
export type NewSignature = typeof signatures.$inferInsert;

/** The `routed_endpoints`, `host_blocklist`, and `target_payments` tables (Payment routing), and the Signer's `signatures`. */
export interface RoutingRepository {
  isBlocked(host: string): Promise<boolean>;
  block(input: { readonly host: string; readonly reason: string }): Promise<void>;
  unblock(host: string): Promise<boolean>;
  /** Whether a registered service uses the host as an upstream, in any state (RT-2, RT-12, RT-14). */
  isServiceHost(host: string): Promise<boolean>;
  /** Registers a routed endpoint once (RT-12, RT-13), up to the cap per host (AR17), never for a service's host. */
  registerEndpoint(input: { readonly host: string; readonly path: string; readonly lastPrice?: bigint }): Promise<EndpointRegistration>;
  /** The endpoint's own fee, if it has one (RT-5). */
  endpointFee(host: string, path: string): Promise<number | undefined>;
  /** Sets an endpoint's own fee, or back to the default with null. Returns whether the endpoint exists. */
  setEndpointFee(input: { readonly host: string; readonly path: string; readonly feeBps: number | null }): Promise<boolean>;
  recordTargetPayment(payment: NewTargetPayment): Promise<void>;
  updateTargetPayment(paymentId: string, change: { readonly status: TargetPaymentStatus; readonly receipt?: string; readonly transactionHash?: string }): Promise<void>;
  findTargetPayment(paymentId: string): Promise<TargetPaymentRecord | undefined>;
  /**
   * Routing losses not booked yet, oldest first: the target leg settled, and the buyer's payment
   * failed, was released, or was cancelled, such as an x402 or MPP settlement that failed after the
   * target was paid (RT-9).
   */
  listUnbookedLosses(limit: number): Promise<readonly UnbookedRoutingLoss[]>;
  recordSignature(signature: NewSignature): Promise<void>;
}

export const createRoutingRepository = ({ db, clock }: { readonly db: DatabaseExecutor; readonly clock: Clock }): RoutingRepository => ({
  isBlocked: async host => (await db.select({ host: hostBlocklist.host }).from(hostBlocklist).where(eq(hostBlocklist.host, host))).length > 0,

  block: async ({ host, reason }) => {
    await db.insert(hostBlocklist).values({ host, reason, createdAt: clock.now() })
      .onConflictDoUpdate({ target: hostBlocklist.host, set: { reason } });
  },

  unblock: async host => (await db.delete(hostBlocklist).where(eq(hostBlocklist.host, host)).returning()).length > 0,

  isServiceHost: async host => (await db.select({ id: services.id }).from(services).where(sql`${host} = any(${services.hosts})`).limit(1)).length > 0,

  registerEndpoint: async ({ host, path, lastPrice }) => {
    if ((await db.select({ id: services.id }).from(services).where(sql`${host} = any(${services.hosts})`).limit(1)).length > 0)
      return 'service_host';
    const [existing] = await db.select({ host: routedEndpoints.host }).from(routedEndpoints)
      .where(and(eq(routedEndpoints.host, host), eq(routedEndpoints.path, path)));
    if (existing) {
      if (lastPrice !== undefined)
        await db.update(routedEndpoints).set({ lastPrice }).where(and(eq(routedEndpoints.host, host), eq(routedEndpoints.path, path)));

      return 'exists';
    }
    const [registered] = await db.select({ count: count() }).from(routedEndpoints).where(eq(routedEndpoints.host, host));
    if ((registered?.count ?? 0) >= maxRoutedEndpointsPerHost)
      return 'capped';
    const created = await db.insert(routedEndpoints).values({ host, path, lastPrice: lastPrice ?? null, createdAt: clock.now() }).onConflictDoNothing().returning();

    return created.length > 0 ? 'created' : 'exists';
  },

  endpointFee: async (host, path) => {
    const [row] = await db.select({ feeBps: routedEndpoints.feeBps }).from(routedEndpoints)
      .where(and(eq(routedEndpoints.host, host), eq(routedEndpoints.path, path)));

    return row?.feeBps ?? undefined;
  },

  setEndpointFee: async ({ host, path, feeBps }) => (await db.update(routedEndpoints).set({ feeBps })
    .where(and(eq(routedEndpoints.host, host), eq(routedEndpoints.path, path))).returning()).length > 0,

  recordTargetPayment: async payment => {
    const now = clock.now();
    await db.insert(targetPayments).values({ ...payment, status: 'signed', createdAt: now, updatedAt: now });
  },

  updateTargetPayment: async (paymentId, { status, receipt, transactionHash }) => {
    await db.update(targetPayments).set({
      status, updatedAt: clock.now(), ...receipt === undefined ? {} : { receipt }, ...transactionHash === undefined ? {} : { transactionHash },
    }).where(eq(targetPayments.paymentId, paymentId));
  },

  findTargetPayment: async paymentId => {
    const [row] = await db.select().from(targetPayments).where(eq(targetPayments.paymentId, paymentId));

    return row;
  },

  listUnbookedLosses: async limit => db.select({
    paymentId: targetPayments.paymentId,
    amount: targetPayments.amount,
    asset: targetPayments.asset,
    targetHost: payments.targetHost,
    buyerStatus: payments.status,
  }).from(targetPayments)
    .innerJoin(payments, eq(payments.id, targetPayments.paymentId))
    .where(and(eq(targetPayments.status, 'settled'), eq(targetPayments.lossBooked, false), inArray(payments.status, [...unchargedStatuses])))
    .orderBy(asc(targetPayments.createdAt), asc(targetPayments.paymentId))
    .limit(limit),

  recordSignature: async signature => {
    await db.insert(signatures).values(signature);
  },
});
