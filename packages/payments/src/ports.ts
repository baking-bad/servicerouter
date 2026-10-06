import type { MicroUsd } from '@servicerouter/common';
import type {
  BillingDecision, CaptureResult, HoldInput, HoldResult, InitialPaymentStatus, NewPayment, Payment, PaymentKey, PaymentStatus,
} from '@servicerouter/core';

// The rails' ports (PR-11): what they need from the Ledger and from Accounts and keys. The adapters
// live in `db`, and apps wire them. Nothing here knows Fastify or Drizzle.

/**
 * Port: the credits side of the Ledger. Each operation is one database transaction, keyed by the
 * payment ID, so a retry never moves money twice (LG-3, rule 4).
 */
export interface CreditsLedger {
  /**
   * Moves the price from the buyer's available credits to held, counts it against the key's daily
   * budget and allowance, and records the payment as `held`, all at once (LG-6, PR-10). Refused when
   * the balance or a limit doesn't cover it. A second hold for the same payment returns the first.
   */
  hold(input: HoldInput): Promise<HoldResult>;
  /**
   * Moves a held payment to the seller's earnings and the platform's fee, `amount × feeBps / 10000`
   * rounded down (LG-4), and records it as `captured`. A second capture moves nothing.
   */
  capture(input: { readonly paymentId: string; readonly feeBps: number }): Promise<CaptureResult>;
  /** Gives a held payment back to the buyer, with the key's spend, and records it as `released`. A second release moves nothing. */
  release(input: { readonly paymentId: string }): Promise<{ readonly payment: Payment }>;
}

/** Port: the `payments` rows (LG-7, PR-10). Only the status changes LG-8 allows go through. */
export interface PaymentRecorder {
  /** Records a payment a rail authorized without a hold, such as a verified x402 payment. */
  create(payment: NewPayment & { readonly status: InitialPaymentStatus }): Promise<Payment>;
  /** Records the billing decision before the payment is finalized (rule 5, PX-11). */
  recordDecision(input: {
    readonly paymentId: string;
    readonly decision: BillingDecision;
    readonly upstreamStatus: number | undefined;
    readonly upstreamLatencyMs: number | undefined;
  }): Promise<Payment>;
  /** Moves a payment to another status. Throws InvalidPaymentStatusChangeError for a change LG-8 doesn't allow. */
  changeStatus(input: {
    readonly paymentId: string;
    readonly to: PaymentStatus;
    readonly fee?: MicroUsd;
    readonly transactionHash?: string;
    readonly receipt?: string;
    readonly needsReview?: boolean;
  }): Promise<Payment>;
  find(paymentId: string): Promise<Payment | undefined>;
}

/** Port: payment keys by hash, with their limits (PR-4). Revoked keys aren't found; expiry is the rail's check. */
export interface KeyStore {
  findByHash(keyHash: string): Promise<PaymentKey | undefined>;
}
