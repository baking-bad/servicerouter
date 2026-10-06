import type { MicroUsd } from '@servicerouter/common';

import type { NewPayment, Payment, RailName } from './payments.js';

/** Why a hold is refused (LG-6, AK-7). Each is a `402` for the buyer (PR-4). */
export const holdRefusals = ['insufficient_balance', 'key_budget_exceeded', 'key_allowance_exceeded'] as const;
export type HoldRefusal = typeof holdRefusals[number];

export interface HoldInput {
  // A credits payment: rail `credits`, with its buyer and key
  readonly payment: NewPayment & { readonly rail: 'credits'; readonly buyerAccountId: string; readonly keyId: string };
  // The key's limits that count against its spend (AK-6)
  readonly dailyBudget: MicroUsd;
  readonly allowance: MicroUsd | undefined;
}

export type HoldResult =
  | { readonly ok: true; readonly payment: Payment }
  | { readonly ok: false; readonly refusal: HoldRefusal };

export interface CaptureResult {
  readonly payment: Payment;
  readonly fee: MicroUsd;
  readonly sellerAmount: MicroUsd;
}

/** A buyer's credits (LG-1): what they can spend, and what is held for calls in flight. */
export interface CreditsBalance {
  readonly available: MicroUsd;
  readonly held: MicroUsd;
}

/** A key's spend so far (LG-6): today's, by the UTC day, and over its life. */
export interface KeySpend {
  readonly today: MicroUsd;
  readonly total: MicroUsd;
}

/** LG-10: a service's earnings. Paid out stays 0 until payouts (step 11). */
export interface ServiceEarnings {
  // Captured or settled calls
  readonly calls: number;
  // What the seller earned, after the fee, by rail
  readonly earnedByRail: Readonly<Partial<Record<RailName, MicroUsd>>>;
  readonly earned: MicroUsd;
  readonly fee: MicroUsd;
  readonly paidOut: MicroUsd;
}

/** One page of a buyer's payments, newest first. */
export interface PaymentPage {
  readonly payments: readonly Payment[];
  // Where the next page starts, or undefined on the last one
  readonly next: string | undefined;
}
