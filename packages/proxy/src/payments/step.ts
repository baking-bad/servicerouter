import type { IdGenerator, Logger, MicroUsd } from '@servicerouter/common';
import type { BillingDecision, RuntimeOperation } from '@servicerouter/core';
import {
  billingDecision, buildPaymentRequired, detectCredential, PaymentInvalidError, type Authorization, type CredentialDetector,
  type PaymentRail, type PaymentRecorder, type PaymentRequired, type Quote, type Receipt, type RequestHeaders,
} from '@servicerouter/payments';

import type { PaymentOutcome, ProxyMetrics } from '../metrics.js';
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

/** A routed call's buyer side (RT-6): the quote for the target, paid like a registered service's call. */
export interface RoutedCallInput {
  readonly headers: RequestHeaders;
  readonly ip: string;
  readonly requestId: string;
  readonly host: string;
  readonly path: string;
  // The routing link, such as https://pay.servicerouter.ai/api.example.com/v1/pools
  readonly resource: string;
  // The target's price plus the routing fee (RT-5)
  readonly quote: MicroUsd;
}

/** The proxy's payment step (rule 5): authorize before forwarding, then decide, record, and finalize. */
export interface PaymentStep {
  /** Like `begin`, for a routed call at its quote (RT-6). The per-service limit counts per target host (RT-15). */
  beginRouted(input: RoutedCallInput): Promise<PaymentStart>;
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
  /**
   * Finalizes a rail that settles before the response (x402 and MPP, PX-12) and returns its receipt.
   * Throws SettlementFailedError when the response must not go out (PR-12).
   */
  settleNow(call: PaidCall): Promise<Receipt>;
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

// Credits holds and captures; x402 and MPP verify and settle
const outcomes = (rail: PaymentRail): Readonly<Record<'authorized' | 'finalized' | 'aborted', PaymentOutcome>> => rail.settlesBeforeResponse
  ? { authorized: 'verified', finalized: 'settled', aborted: 'cancelled' }
  : { authorized: 'held', finalized: 'captured', aborted: 'released' };

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
      metrics.payment(rail.name, outcomes(rail)[decision === 'billable' ? 'finalized' : 'aborted']);
    }
    catch (error) {
      metrics.payment(rail.name, 'finalize_failed');
      logger.error({ error, paymentId, decision }, 'Failed to finish a payment. The hold expiry worker finishes it.');
    }
  };

  // Detects the credential, checks the limits, and authorizes it, or answers with the combined 402
  const start = async ({ headers, ip }: { readonly headers: RequestHeaders; readonly ip: string }, quote: Quote, scope: string): Promise<PaymentStart> => {
      const credential = detectCredential(detectors, headers);
      const rail = credential && rails.find(candidate => candidate.name === credential.rail);
      if (!credential || !rail) {
        await limits.unpaid(ip);
        metrics.payment(credential?.rail ?? 'none', 'challenged');

        return { kind: 'challenge', response: await buildPaymentRequired(rails, quote) };
      }

      if (credential.rail === 'credits' && credential.key.kind === 'payment')
        await limits.paymentKey(credential.key.hash);
      await limits.service(scope);
      let authorization: Authorization;
      try {
        authorization = await rail.authorize(credential, quote);
      }
      catch (error) {
        metrics.payment(rail.name, error instanceof PaymentInvalidError ? 'payment_invalid' : 'refused');
        throw error;
      }
      metrics.payment(rail.name, outcomes(rail).authorized);

      return {
        kind: 'paid',
        call: { rail, authorization },
        upstreamHeaders: { [buyerHeader]: buyerHeaderValue(authorization.buyer, scope) },
      };
  };

  return {
    begin: async ({ headers, ip, requestId, serviceId, ownerAccountId, operation, path }) => start({ headers, ip }, {
      paymentId: `${paymentIdPrefix}${ids.next()}`,
      requestId,
      resource: `${payUrl.replace(/\/+$/, '')}/service/${serviceId}${path}`,
      priceMicroUsd: operation.price,
      description: describe(operation),
      subject: { kind: 'service', serviceId, routeKey: operation.routeKey, sellerAccountId: ownerAccountId },
      feeBps,
    }, serviceId),
    beginRouted: async ({ headers, ip, requestId, host, path, resource, quote }) => start({ headers, ip }, {
      paymentId: `${paymentIdPrefix}${ids.next()}`,
      requestId,
      resource,
      priceMicroUsd: quote,
      description: `${host}${path}, through Service Router`,
      subject: { kind: 'routed', targetHost: host, targetPath: path },
      // The routing fee is in the quote: the ledger splits it from the target's price (RT-5)
      feeBps: 0,
    }, `host:${host}`),
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
    settleNow: async ({ rail, authorization }) => {
      try {
        const receipt = await rail.finalize(authorization);
        metrics.payment(rail.name, 'settled');

        return receipt;
      }
      catch (error) {
        metrics.payment(rail.name, 'settlement_failed');
        throw error;
      }
    },
    drain: async () => {
      while (finishing.size > 0)
        await Promise.allSettled([...finishing]);
    },
  };
};
