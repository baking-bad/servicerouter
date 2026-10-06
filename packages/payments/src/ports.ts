import type { Store } from 'mppx';

import type { MicroUsd } from '@servicerouter/common';
import type {
  BillingDecision, CaptureResult, HoldInput, HoldResult, InitialPaymentStatus, JsonObject, NewPayment, Payment, PaymentKey, PaymentStatus,
  SettleInput,
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
  /**
   * Records a payment a rail authorized without a hold, such as a verified x402 payment. An MPP payment
   * knows its transaction hash before the broadcast (PR-9).
   */
  create(payment: NewPayment & { readonly status: InitialPaymentStatus; readonly transactionHash?: string }): Promise<Payment>;
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
    // The settle request to repeat while `settling` (PR-12, WK-6). Null clears it.
    readonly settlementRequest?: JsonObject | null;
  }): Promise<Payment>;
  find(paymentId: string): Promise<Payment | undefined>;
}

/**
 * Port: books a settled on-chain payment (x402, MPP) with its change to `settled`, in one database
 * transaction keyed by the payment ID (LG-3, LG-4, PR-10). A second settle moves nothing.
 */
export interface SettlementLedger {
  settle(input: SettleInput): Promise<CaptureResult>;
}

/** Port: payment keys by hash, with their limits (PR-4). Revoked keys aren't found; expiry is the rail's check. */
export interface KeyStore {
  findByHash(keyHash: string): Promise<PaymentKey | undefined>;
}

/**
 * Port: the MPP replay store (PR-9), `mppx`'s atomic key-value store. Shared by every proxy replica,
 * so a credential works once across all of them. `db` implements it on Redis.
 */
export type ReplayStore = Store.AtomicStore;
