import { formatUsd, ServiceRouterError, type IdGenerator, type Logger, type LogSink, type MicroUsd } from '@servicerouter/common';
import type { BillingDecision, RuntimeOperation } from '@servicerouter/core';
import {
  billingDecision, buildPaymentRequired, detectCredential, PaymentInvalidError, SettlementFailedError, type Authorization, type CredentialDetector,
  type PaymentRail, type PaymentRecorder, type PaymentRequired, type Quote, type Receipt, type RequestHeaders,
} from '@servicerouter/payments';

import type { PaymentOutcome, ProxyMetrics } from '../metrics.js';
import { buyerHeader, type BuyerHeaderValue } from './buyer.js';
import type { ProxyLimits } from './limits.js';

// Payment IDs: `pay_<id>`
export const paymentIdPrefix = 'pay_';

/** What a paid call's outcome line reports (L-3), filled in as the call goes. */
export interface PaidCallTrace {
  // The service and route, or the routed target's host and path
  readonly subject: Readonly<Record<string, string>>;
  readonly verifyMs: number;
  upstreamMs?: number;
  // Undefined: no answer from the upstream
  upstreamStatus?: number | undefined;
  upstreamRequestId?: string;
  decision?: BillingDecision;
}

/** A call whose payment is authorized: what to finalize or abort once the answer is known. */
export interface PaidCall {
  readonly rail: PaymentRail;
  readonly authorization: Authorization;
  // The request's logger, so the call's lines carry its request ID (XC-5)
  readonly log: LogSink;
  readonly trace: PaidCallTrace;
}

export type PaymentStart =
  // No credential, or one whose rail isn't served yet: the combined 402
  | { readonly kind: 'challenge'; readonly response: PaymentRequired }
  // Authorized: forward with these extra request headers (PX-15)
  | { readonly kind: 'paid'; readonly call: PaidCall; readonly upstreamHeaders: Readonly<Record<string, string>> };

export interface PaymentCallInput {
  readonly headers: RequestHeaders;
  // The request's logger. Default: the step's.
  readonly log?: LogSink;
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
  // The request's logger. Default: the step's.
  readonly log?: LogSink;
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
  /**
   * Records the billing decision on the payment row before anything is finalized (rule 5, PX-11). The
   * upstream's own request ID, when it sent one, goes on the call's outcome line (L-2).
   */
  decide(call: PaidCall, outcome: { readonly status: number | undefined; readonly latencyMs: number; readonly upstreamRequestId?: string | undefined }): Promise<BillingDecision>;
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

// Refusals the buyer caused: logged at info with their code (L-3). Anything else is the platform's fault.
const buyerRefusals = new Set([
  'insufficient_balance', 'key_budget_exceeded', 'key_allowance_exceeded', 'key_price_limit', 'payment_invalid', 'invalid_key', 'wrong_key_type',
]);

const roundMs = (started: number): number => Math.round(performance.now() - started);

/** The fields every line about a paid call carries (L-3). */
const callFields = ({ rail, authorization, trace }: PaidCall): Record<string, unknown> => ({
  paymentId: authorization.paymentId,
  rail: rail.name,
  ...authorization.network === undefined ? {} : { network: authorization.network },
  ...authorization.asset === undefined ? {} : { asset: authorization.asset },
  amount: formatUsd(authorization.amount),
  ...trace.subject,
  ...trace.decision === undefined ? {} : { decision: trace.decision },
  verifyMs: trace.verifyMs,
  ...trace.upstreamMs === undefined ? {} : { upstreamMs: trace.upstreamMs },
  upstreamStatus: trace.upstreamStatus ?? null,
  ...trace.upstreamRequestId === undefined ? {} : { upstreamRequestId: trace.upstreamRequestId },
});

/** What a failed settlement says (L-3): its outcome, the facilitator's errorReason or the RPC's message, the transaction. */
const settlementFields = (error: SettlementFailedError): Record<string, unknown> => ({
  ...error.outcome === undefined ? {} : { outcome: error.outcome },
  ...error.reason === undefined ? {} : { reason: error.reason },
  ...error.transaction === undefined ? {} : { transaction: error.transaction },
  ...error.facilitator === undefined ? {} : { facilitator: error.facilitator },
});

export const createPaymentStep = ({
  rails, detectors, recorder, limits, buyerHeaderValue, ids, feeBps, payUrl, logger, metrics,
}: PaymentStepOptions): PaymentStep => {
  const finishing = new Set<Promise<void>>();

  const settle = async (call: PaidCall, decision: BillingDecision): Promise<void> => {
    const { rail, authorization, log } = call;
    const started = performance.now();
    try {
      if (decision === 'billable')
        await rail.finalize(authorization);
      else
        await rail.abort(authorization);
      const outcome = outcomes(rail)[decision === 'billable' ? 'finalized' : 'aborted'];
      metrics.payment(rail.name, outcome);
      // L-3: one line per paid call
      log.info({ ...callFields(call), decision, paymentStatus: outcome, settleMs: roundMs(started) }, 'Paid call finished');
    }
    catch (error) {
      metrics.payment(rail.name, 'finalize_failed');
      // A ledger write that failed: the worker finishes the payment from its recorded decision (LG-9)
      log.error({ ...callFields(call), error, decision, paymentStatus: 'finalize_failed', settleMs: roundMs(started) },
        'Failed to finish a payment. The hold expiry worker finishes it.');
    }
  };

  // Detects the credential, checks the limits, and authorizes it, or answers with the combined 402
  const start = async (
    { headers, ip, log }: { readonly headers: RequestHeaders; readonly ip: string; readonly log: LogSink },
    quote: Quote,
    scope: string,
    subject: Readonly<Record<string, string>>,
  ): Promise<PaymentStart> => {
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
      const started = performance.now();
      try {
        authorization = await rail.authorize(credential, { ...quote, log });
      }
      catch (error) {
        metrics.payment(rail.name, error instanceof PaymentInvalidError ? 'payment_invalid' : 'refused');
        const fields = { paymentId: quote.paymentId, rail: rail.name, amount: formatUsd(quote.priceMicroUsd), ...subject, verifyMs: roundMs(started) };
        const code = error instanceof ServiceRouterError ? error.code : undefined;
        // L-3: a refusal the buyer caused is info, with its code and the facilitator's reason
        if (code !== undefined && buyerRefusals.has(code)) {
          const { reason, facilitator } = error as Partial<PaymentInvalidError>;
          log.info({ ...fields, code, ...reason === undefined ? {} : { reason }, ...facilitator === undefined ? {} : { facilitator } }, 'Paid call refused');
        }
        // A facilitator, the Tempo RPC, or the replay store that failed: the platform's fault
        else
          log.warn({ ...fields, ...code === undefined ? {} : { code }, error }, 'Paid call refused: the payment couldn\'t be checked');
        throw error;
      }
      metrics.payment(rail.name, outcomes(rail).authorized);

      return {
        kind: 'paid',
        call: { rail, authorization, log, trace: { subject, verifyMs: roundMs(started) } },
        upstreamHeaders: { [buyerHeader]: buyerHeaderValue(authorization.buyer, scope) },
      };
  };

  return {
    begin: async ({ headers, ip, log = logger, requestId, serviceId, ownerAccountId, operation, path }) => start({ headers, ip, log }, {
      paymentId: `${paymentIdPrefix}${ids.next()}`,
      requestId,
      resource: `${payUrl.replace(/\/+$/, '')}/service/${serviceId}${path}`,
      priceMicroUsd: operation.price,
      description: describe(operation),
      subject: { kind: 'service', serviceId, routeKey: operation.routeKey, sellerAccountId: ownerAccountId },
      feeBps,
    }, serviceId, { serviceId, ...operation.routeKey === undefined ? {} : { routeKey: operation.routeKey } }),
    beginRouted: async ({ headers, ip, log = logger, requestId, host, path, resource, quote }) => start({ headers, ip, log }, {
      paymentId: `${paymentIdPrefix}${ids.next()}`,
      requestId,
      resource,
      priceMicroUsd: quote,
      description: `${host}${path}, through Service Router`,
      subject: { kind: 'routed', targetHost: host, targetPath: path },
      // The routing fee is in the quote: the ledger splits it from the target's price (RT-5)
      feeBps: 0,
    }, `host:${host}`, { host, path }),
    decide: async (call, { status, latencyMs, upstreamRequestId }) => {
      const { authorization, trace, log } = call;
      const decision = billingDecision(status);
      trace.decision = decision;
      trace.upstreamStatus = status;
      trace.upstreamMs = latencyMs;
      if (upstreamRequestId !== undefined)
        trace.upstreamRequestId = upstreamRequestId;
      try {
        await recorder.recordDecision({ paymentId: authorization.paymentId, decision, upstreamStatus: status, upstreamLatencyMs: latencyMs });
      }
      catch (error) {
        // Without a recorded decision the worker releases: the buyer is never charged by mistake
        log.error({ error, paymentId: authorization.paymentId, decision }, 'Failed to record the billing decision');
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
    settleNow: async call => {
      const { rail, authorization, log } = call;
      const started = performance.now();
      try {
        const receipt = await rail.finalize(authorization);
        metrics.payment(rail.name, 'settled');
        const { settlement } = receipt;
        const fields = {
          ...callFields(call), paymentStatus: settlement?.status ?? 'settled', settleMs: roundMs(started),
          ...settlement?.transaction === undefined ? {} : { transaction: settlement.transaction },
        };
        // L-3: broadcast, not final yet, is the platform's to watch: the follow-up finishes it
        if (settlement?.status === 'settling')
          log.warn({ ...fields, reason: 'settlement_pending' }, 'Paid call finished: its settlement is pending');
        else
          log.info(fields, 'Paid call finished');

        return receipt;
      }
      catch (error) {
        metrics.payment(rail.name, 'settlement_failed');
        const fields = { ...callFields(call), settleMs: roundMs(started) };
        // L-3: a failed or unknown settlement says why; anything else, such as a ledger write, is an error
        if (error instanceof SettlementFailedError)
          log.warn({ ...fields, paymentStatus: error.outcome === 'unknown' ? 'settling' : 'failed', ...settlementFields(error) }, 'Paid call failed to settle');
        else
          log.error({ ...fields, paymentStatus: 'settlement_failed', error }, 'Paid call failed to settle');
        throw error;
      }
    },
    drain: async () => {
      while (finishing.size > 0)
        await Promise.allSettled([...finishing]);
    },
  };
};
