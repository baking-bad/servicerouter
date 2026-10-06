import type { Logger } from '@servicerouter/common';
import { rateLimitClient, RateLimitedError, type PlatformConfig, type RateLimiter } from '@servicerouter/core';

import type { ProxyMetrics } from '../metrics.js';

export type LimitName = 'paymentKey' | 'service' | 'unpaidIp';

/** PX-13: rate limits in Redis, shared by every replica. Each throws RateLimitedError over its limit. */
export interface ProxyLimits {
  /** A request that gets only the `402`, per client IP. */
  unpaid(ip: string): Promise<void>;
  /** A request with a payment key, per key: by its hash, before any lookup. */
  paymentKey(keyHash: string): Promise<void>;
  /** A paid request, per service. Keyed by service ID, never by hostname. */
  service(serviceId: string): Promise<void>;
}

export interface ProxyLimitsOptions {
  readonly limiter: RateLimiter;
  readonly limits: PlatformConfig['rateLimits'];
  readonly logger: Logger;
  readonly metrics: ProxyMetrics;
}

/**
 * The proxy's limits, as fixed windows under `rl:proxy:<limit>:<key>`. While Redis fails, a limit lets
 * the request through and logs it: paid calls keep working, and the Ledger still guards the money.
 */
export const createProxyLimits = ({ limiter, limits, logger, metrics }: ProxyLimitsOptions): ProxyLimits => {
  const hit = async (name: LimitName, key: string): Promise<void> => {
    let allowed: boolean;
    let retryAfterSeconds: number;
    try {
      ({ allowed, retryAfterSeconds } = await limiter.hit(`proxy:${name}:${key}`, limits[name]));
    }
    catch (error) {
      metrics.rateLimiterError();
      logger.warn({ error, limit: name }, 'The rate limiter failed, so the request goes through');
      return;
    }
    if (allowed)
      return;

    metrics.rateLimited(name);
    throw new RateLimitedError(retryAfterSeconds);
  };

  return {
    unpaid: ip => hit('unpaidIp', rateLimitClient(ip)),
    paymentKey: keyHash => hit('paymentKey', keyHash),
    service: serviceId => hit('service', serviceId),
  };
};
