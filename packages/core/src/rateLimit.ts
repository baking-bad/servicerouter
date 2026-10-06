import { ServiceRouterError } from '@servicerouter/common';

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
