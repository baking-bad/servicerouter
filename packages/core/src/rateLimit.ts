import { parseIpAddress, ServiceRouterError, unmapIpv4 } from '@servicerouter/common';

import type { RateLimit } from './platform/config.js';

export interface RateLimitDecision {
  readonly allowed: boolean;
  // Seconds until the window resets. Over the limit, this goes in Retry-After.
  readonly retryAfterSeconds: number;
}

/** Port: counts hits per key in a window shared by every replica (PA-5, PX-13). */
export interface RateLimiter {
  hit(key: string, limit: RateLimit): Promise<RateLimitDecision>;
}

export class RateLimitedError extends ServiceRouterError {
  readonly code = 'rate_limited';
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`Too many requests. Retry after ${retryAfterSeconds} s`);

    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The client a per-IP limit counts: an IPv4 address, or the /64 of an IPv6 address, since one
 * subscriber usually holds a whole /64 (PA-5, PX-13).
 */
export const rateLimitClient = (ip: string): string => {
  const parsed = parseIpAddress(ip);
  if (!parsed)
    return ip;

  const address = unmapIpv4(parsed);
  if (address.version === 4)
    return address.bytes.join('.');

  const words = Array.from({ length: 4 }, (_, index) => ((address.bytes[index * 2]! << 8) | address.bytes[index * 2 + 1]!).toString(16));

  return `${words.join(':')}::/64`;
};
