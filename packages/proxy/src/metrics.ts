import { Counter, Histogram, type Registry } from '@prometheus-io/client';

export interface ProxyMetrics {
  cacheLookup(result: 'hit' | 'miss'): void;
  invalidation(kind: string): void;
  reconnect(): void;
  /** One upstream call: its status, or the reason it failed. */
  upstream(serviceId: string, outcome: { readonly status: number } | { readonly reason: string }, seconds: number): void;
}

/**
 * The proxy's metrics on the internal port (XC-2): upstream latency and errors by service, runtime
 * cache hits and misses, and invalidation events. Service labels come only from loaded services, so
 * random IDs in URLs can't grow the series.
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
  const upstreamErrors = new Counter({
    name: 'proxy_upstream_errors_total',
    help: 'Upstream calls answered with 503 upstream_unavailable, by service and reason',
    labelNames: ['service', 'reason'] as const,
    registers: [registry],
  });

  return {
    cacheLookup: result => cacheLookups.inc({ result }),
    invalidation: kind => invalidations.inc({ kind }),
    reconnect: () => reconnects.inc(),
    upstream: (service, outcome, seconds) => {
      upstreamDuration.observe({ service, status: 'status' in outcome ? String(outcome.status) : 'error' }, seconds);
      if ('reason' in outcome)
        upstreamErrors.inc({ service, reason: outcome.reason });
    },
  };
};
