import { Counter, Histogram, type Registry } from '@prometheus-io/client';

/**
 * What happened to a paid call's payment (XC-2). Credits: held, then captured or released. x402 and
 * MPP: verified, then settled (or settling) or cancelled, or settlement_failed. A refused payment is
 * payment_invalid when the payment itself was wrong, refused otherwise.
 */
export type PaymentOutcome =
  | 'challenged' | 'held' | 'verified' | 'refused' | 'payment_invalid' | 'captured' | 'released' | 'settled' | 'cancelled' | 'settlement_failed'
  | 'finalize_failed';

export interface ProxyMetrics {
  cacheLookup(result: 'hit' | 'miss'): void;
  keyCacheLookup(result: 'hit' | 'miss'): void;
  invalidation(kind: string): void;
  reconnect(): void;
  /** One upstream call: its status, or the reason it failed. */
  upstream(serviceId: string, outcome: { readonly status: number } | { readonly reason: string }, seconds: number): void;
  payment(rail: string, outcome: PaymentOutcome): void;
  rateLimited(limit: string): void;
  rateLimiterError(): void;
}

/**
 * The proxy's metrics on the internal port (XC-2): upstream latency and errors by service, runtime
 * and key cache hits and misses, invalidation events, payments by rail and outcome, and rate limits.
 * Service labels come only from loaded services, so random IDs in URLs can't grow the series.
 */
export const createProxyMetrics = (registry: Registry): ProxyMetrics => {
  const cacheLookups = new Counter({
    name: 'proxy_runtime_cache_lookups_total',
    help: 'Runtime cache lookups, by result: hit or miss',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const invalidations = new Counter({
    name: 'proxy_invalidation_events_total',
    help: 'Invalidation events received, by kind',
    labelNames: ['kind'] as const,
    registers: [registry],
  });
  const reconnects = new Counter({
    name: 'proxy_invalidation_reconnects_total',
    help: 'Times the invalidation subscription came back after a drop, each clearing the runtime cache',
    registers: [registry],
  });
  const upstreamDuration = new Histogram({
    name: 'proxy_upstream_request_duration_seconds',
    help: 'Upstream latency until the response headers, by service and status, or "error"',
    labelNames: ['service', 'status'] as const,
    registers: [registry],
  });
  const keyCacheLookups = new Counter({
    name: 'proxy_key_cache_lookups_total',
    help: 'Payment key cache lookups, by result: hit or miss',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const payments = new Counter({
    name: 'proxy_payments_total',
    help: 'Paid calls by rail and outcome: challenged (402), held or verified, refused or payment_invalid, captured or settled, released or cancelled, settlement_failed, finalize_failed',
    labelNames: ['rail', 'outcome'] as const,
    registers: [registry],
  });
  const rateLimited = new Counter({
    name: 'proxy_rate_limited_total',
    help: 'Requests answered with 429 rate_limited, by limit',
    labelNames: ['limit'] as const,
    registers: [registry],
  });
  const rateLimiterErrors = new Counter({
    name: 'proxy_rate_limiter_errors_total',
    help: 'Rate limit checks that failed, so the request went through',
    registers: [registry],
  });
  const upstreamErrors = new Counter({
    name: 'proxy_upstream_errors_total',
    help: 'Upstream calls answered with 503 upstream_unavailable, by service and reason',
    labelNames: ['service', 'reason'] as const,
    registers: [registry],
  });

  return {
    cacheLookup: result => cacheLookups.inc({ result }),
    keyCacheLookup: result => keyCacheLookups.inc({ result }),
    invalidation: kind => invalidations.inc({ kind }),
    reconnect: () => reconnects.inc(),
    upstream: (service, outcome, seconds) => {
      upstreamDuration.observe({ service, status: 'status' in outcome ? String(outcome.status) : 'error' }, seconds);
      if ('reason' in outcome)
        upstreamErrors.inc({ service, reason: outcome.reason });
    },
    payment: (rail, outcome) => payments.inc({ rail, outcome }),
    rateLimited: limit => rateLimited.inc({ limit }),
    rateLimiterError: () => rateLimiterErrors.inc(),
  };
};
