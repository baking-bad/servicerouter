import type { BillingDecision } from '@servicerouter/core';

import type { PaymentRail, Quote } from './rail.js';

/** The combined `402` (PR-2): one response with every rail's challenge. */
export interface PaymentRequired {
  readonly status: 402;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * Assembles the combined `402` from each rail's `challenge()`, in rail order: their headers, and
 * their fields of one JSON body. Never cached (PR-2). The agent retries with exactly one of them.
 */
export const buildPaymentRequired = async (rails: readonly Pick<PaymentRail, 'challenge'>[], quote: Quote): Promise<PaymentRequired> => {
  const headers: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  for (const part of await Promise.all(rails.map(rail => rail.challenge(quote)))) {
    Object.assign(headers, part?.headers);
    Object.assign(body, part?.body);
  }

  return { status: 402, headers: { ...headers, 'cache-control': 'no-store' }, body };
};

/** PX-11: billable means a `2xx` answer, until a config adds `chargeOn`. No answer is never billable. */
export const billingDecision = (status: number | undefined): BillingDecision =>
  status !== undefined && status >= 200 && status < 300 ? 'billable' : 'not_billable';
