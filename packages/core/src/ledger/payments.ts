import { ServiceRouterError, type MicroUsd } from '@servicerouter/common';

// The `payments` table (LG-7, LG-8): one row per paid call, the source of truth for seller earnings on every rail.

export const paymentStatuses = ['held', 'verified', 'captured', 'settling', 'settled', 'released', 'cancelled', 'failed'] as const;
export type PaymentStatus = typeof paymentStatuses[number];

export const paymentKinds = ['service', 'routed'] as const;
export type PaymentKind = typeof paymentKinds[number];

export const railNames = ['credits', 'x402', 'mpp'] as const;
export type RailName = typeof railNames[number];

/** Recorded before money moves at the end of a call (rule 5): billable means a 2xx answer (PX-11). */
export const billingDecisions = ['billable', 'not_billable'] as const;
export type BillingDecision = typeof billingDecisions[number];

// LG-8: where each status may go. Credits hold, then capture or release. x402 and MPP verify, then
// settle (maybe through settling) or cancel. Everything else is final.
const nextStatuses: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  held: ['captured', 'released'],
  verified: ['settling', 'settled', 'cancelled', 'failed'],
  settling: ['settled', 'failed'],
  captured: [],
  settled: [],
  released: [],
  cancelled: [],
  failed: [],
};

/** The statuses a payment starts in: held for credits, verified for x402 and MPP. */
export const initialPaymentStatuses = ['held', 'verified'] as const satisfies readonly PaymentStatus[];
export type InitialPaymentStatus = typeof initialPaymentStatuses[number];

/** Whether LG-8 allows a payment to move from one status to another. */
export const canChangePaymentStatus = (from: PaymentStatus, to: PaymentStatus): boolean => nextStatuses[from].includes(to);

/** The statuses a payment may move to `to` from. */
export const statusesBefore = (to: PaymentStatus): readonly PaymentStatus[] => paymentStatuses.filter(from => canChangePaymentStatus(from, to));

/** What a paid call is, as recorded when it is authorized (LG-7). */
export interface NewPayment {
  readonly id: string;
  readonly requestId: string | undefined;
  readonly kind: PaymentKind;
  readonly rail: RailName;
  // The credits account that pays, when known. x402 and MPP payers may have none.
  readonly buyerAccountId: string | undefined;
  // The payment key, for credits
  readonly keyId: string | undefined;
  // Who earns: the service's owner. Routed calls have none.
  readonly sellerAccountId: string | undefined;
  // A registered service's call
  readonly serviceId: string | undefined;
  readonly routeKey: string | undefined;
  // A routed call's target
  readonly targetHost: string | undefined;
  readonly targetPath: string | undefined;
  // On-chain rails: the network, the asset, and the amount in the asset's atomic units
  readonly network: string | undefined;
  readonly asset: string | undefined;
  readonly atomicAmount: bigint | undefined;
  // The price in micro-USD
  readonly amount: MicroUsd;
}

export interface Payment extends NewPayment {
  readonly status: PaymentStatus;
  // The platform's share, set at capture or settlement (LG-4)
  readonly fee: MicroUsd | undefined;
  readonly decision: BillingDecision | undefined;
  readonly upstreamStatus: number | undefined;
  readonly upstreamLatencyMs: number | undefined;
  readonly transactionHash: string | undefined;
  readonly receipt: string | undefined;
  readonly needsReview: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** LG-8: the change isn't allowed from the payment's current status. */
export class InvalidPaymentStatusChangeError extends ServiceRouterError {
  readonly code = 'invalid_payment_status_change';
  readonly paymentId: string;

  constructor(paymentId: string, from: PaymentStatus | undefined, to: PaymentStatus) {
    super(from === undefined
      ? `The payment ${paymentId} doesn't exist, so it can't become ${to}`
      : `The payment ${paymentId} can't go from ${from} to ${to}`);

    this.paymentId = paymentId;
  }
}

/** The payment is finished, or doesn't exist, so its billing decision can't be recorded (rule 5). */
export class PaymentFinalizedError extends ServiceRouterError {
  readonly code = 'payment_finalized';
  readonly paymentId: string;

  constructor(paymentId: string, status: PaymentStatus | undefined) {
    super(status === undefined
      ? `The payment ${paymentId} doesn't exist`
      : `The payment ${paymentId} is ${status}, so its billing decision can't change`);

    this.paymentId = paymentId;
  }
}

/**
 * LG-4: the platform's fee, `amount × feeBps / 10000` rounded down to the micro-USD (AR6), plus the
 * flat fee of the facilitator that settled the payment, if any (P-2). The fee never passes the
 * amount, so the seller's share is never negative. The seller gets the rest, so the two always add
 * up to the amount.
 */
export const splitFee = (amount: MicroUsd, feeBps: number, feePerPayment: MicroUsd = 0n): { readonly fee: MicroUsd; readonly sellerAmount: MicroUsd } => {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000)
    throw new RangeError('feeBps must be an integer from 0 to 10000');
  if (amount < 0n)
    throw new RangeError('The amount must not be negative');
  if (feePerPayment < 0n)
    throw new RangeError('The fee per payment must not be negative');

  const share = amount * BigInt(feeBps) / 10_000n + feePerPayment;
  const fee = share < amount ? share : amount;

  return { fee, sellerAmount: amount - fee };
};

/** The UTC date of a moment: the day a daily budget counts (AR5). */
export const utcDay = (moment: Date): string => moment.toISOString().slice(0, 10);

/** The next monthly payout: the 1st of next month, UTC, as `YYYY-MM-DD` (LG-10). */
export const nextPayoutDate = (now: Date): string =>
  utcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));

/** An operator reused a credit's reference for another account or amount: references are idempotency keys (LG-3). */
export class CreditReferenceConflictError extends ServiceRouterError {
  readonly code = 'idempotency_conflict';

  constructor() {
    super('This reference was already used for another credit: another account or amount');
  }
}
