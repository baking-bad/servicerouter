import type { IdGenerator, Logger } from '@servicerouter/common';
import type { BillingDecision, RuntimeOperation } from '@servicerouter/core';
import {
  billingDecision, buildPaymentRequired, detectCredential, type Authorization, type CredentialDetector, type PaymentRail,
  type PaymentRecorder, type PaymentRequired, type Quote, type RequestHeaders,
} from '@servicerouter/payments';

import type { ProxyMetrics } from '../metrics.js';
import { buyerHeader, type BuyerHeaderValue } from './buyer.js';
import type { ProxyLimits } from './limits.js';

// Payment IDs: `pay_<id>`
export const paymentIdPrefix = 'pay_';

/** A call whose payment is authorized: what to finalize or abort once the answer is known. */
export interface PaidCall {
  readonly rail: PaymentRail;
  readonly authorization: Authorization;
}

export type PaymentStart =
  // No credential, or one whose rail isn't served yet: the combined 402
  | { readonly kind: 'challenge'; readonly response: PaymentRequired }
  // Authorized: forward with these extra request headers (PX-15)
  | { readonly kind: 'paid'; readonly call: PaidCall; readonly upstreamHeaders: Readonly<Record<string, string>> };

export interface PaymentCallInput {
  readonly headers: RequestHeaders;
  // The client IP, for the unpaid limit
  readonly ip: string;
  readonly requestId: string;
  readonly serviceId: string;
  readonly ownerAccountId: string;
  readonly operation: RuntimeOperation;
  // The path after `/service/<id>`, such as `/weather/oslo`, for the quote's resource
  readonly path: string;
}

/** The proxy's payment step (rule 5): authorize before forwarding, then decide, record, and finalize. */
export interface PaymentStep {
  /**
   * Detects the credential (PR-1), checks the limits (PX-13), and authorizes it, or returns the
   * combined 402. Throws a coded error for two credentials, a bad key, a refused hold, or a limit.
   */
  begin(input: PaymentCallInput): Promise<PaymentStart>;
  /** Records the billing decision on the payment row before anything is finalized (rule 5, PX-11). */
  decide(call: PaidCall, outcome: { readonly status: number | undefined; readonly latencyMs: number }): Promise<BillingDecision>;
  /**
   * Captures after a billable answer, releases otherwise. Never throws: a failure is logged, and the
   * hold expiry worker finishes the payment from its recorded decision (LG-9).
   */
  finish(call: PaidCall, decision: BillingDecision): Promise<void>;
  /** Waits for every finish in flight, so shutdown finishes or releases its holds (PX-18). */
  drain(): Promise<void>;
}

export interface PaymentStepOptions {
  // The rails that take payments, in challenge order. Credits from step 4.
  readonly rails: readonly PaymentRail[];
  // Every kind of credential, served or not, so two of any kind get 400 (PR-1)
  readonly detectors: readonly CredentialDetector[];
  readonly recorder: Pick<PaymentRecorder, 'recordDecision'>;
  readonly limits: ProxyLimits;
  readonly buyerHeaderValue: BuyerHeaderValue;
  readonly ids: IdGenerator;
  // The platform's fee on registered services (LG-4)
  readonly feeBps: number;
  // The canonical pay URL (PX-10)
  readonly payUrl: string;
  readonly logger: Logger;
  readonly metrics: ProxyMetrics;
}

const describe = (operation: RuntimeOperation): string =>
  operation.docs.summary ?? operation.routeKey ?? `${operation.method.toUpperCase()} ${operation.path}`;

export const createPaymentStep = ({
  rails, detectors, recorder, limits, buyerHeaderValue, ids, feeBps, payUrl, logger, metrics,
}: PaymentStepOptions): PaymentStep => {
  const finishing = new Set<Promise<void>>();

  const settle = async ({ rail, authorization }: PaidCall, decision: BillingDecision): Promise<void> => {
    const { paymentId } = authorization;
    try {
      if (decision === 'billable')
        await rail.finalize(authorization);
      else
        await rail.abort(authorization);
      metrics.payment(rail.name, decision === 'billable' ? 'captured' : 'released');
    }
    catch (error) {
      metrics.payment(rail.name, 'finalize_failed');
      logger.error({ error, paymentId, decision }, 'Failed to finish a payment. The hold expiry worker finishes it.');
    }
  };

  return {
    begin: async ({ headers, ip, requestId, serviceId, ownerAccountId, operation, path }) => {
      const credential = detectCredential(detectors, headers);
      const quote: Quote = {
        paymentId: `${paymentIdPrefix}${ids.next()}`,
        requestId,
        resource: `${payUrl.replace(/\/+$/, '')}/service/${serviceId}${path}`,
        priceMicroUsd: operation.price,
        description: describe(operation),
        subject: { kind: 'service', serviceId, routeKey: operation.routeKey, sellerAccountId: ownerAccountId },
        feeBps,
      };
      const rail = credential && rails.find(candidate => candidate.name === credential.rail);
      if (!credential || !rail) {
        await limits.unpaid(ip);
        metrics.payment(credential?.rail ?? 'none', 'challenged');

        return { kind: 'challenge', response: buildPaymentRequired(rails, quote) };
      }

      if (credential.rail === 'credits' && credential.key.kind === 'payment')
        await limits.paymentKey(credential.key.hash);
      await limits.service(serviceId);
      let authorization: Authorization;
      try {
        authorization = await rail.authorize(credential, quote);
      }
      catch (error) {
        metrics.payment(rail.name, 'refused');
        throw error;
      }
      metrics.payment(rail.name, 'held');

      return {
        kind: 'paid',
        call: { rail, authorization },
        upstreamHeaders: { [buyerHeader]: buyerHeaderValue(authorization.buyer, serviceId) },
      };
    },
    decide: async ({ authorization }, { status, latencyMs }) => {
      const decision = billingDecision(status);
      try {
        await recorder.recordDecision({ paymentId: authorization.paymentId, decision, upstreamStatus: status, upstreamLatencyMs: latencyMs });
      }
      catch (error) {
        // Without a recorded decision the worker releases: the buyer is never charged by mistake
        logger.error({ error, paymentId: authorization.paymentId, decision }, 'Failed to record the billing decision');
      }

      return decision;
    },
    finish: async (call, decision) => {
      // Tracked from the call on, so a drain that starts right after sees it
      const finished = settle(call, decision);
      finishing.add(finished);
      try {
        await finished;
      }
      finally {
        finishing.delete(finished);
      }
    },
    drain: async () => {
      while (finishing.size > 0)
        await Promise.allSettled([...finishing]);
    },
  };
};
