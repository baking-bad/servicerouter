import type { RateLimiter } from '@servicerouter/core';

import { RedisNotReadyError, type Redis } from './redis.js';

// The key space after the connection's prefix (section 5: `rl:*`)
export const rateLimitKeyPrefix = 'rl:';

export interface RedisRateLimiterOptions {
  readonly redis: Redis;
}

/**
 * A fixed window per key in Redis, shared by every replica. The first hit starts the window. INCR and
 * the expiry run in one MULTI, so a crash between them can't leave a counter that never expires.
 * While Redis is disconnected it throws RedisNotReadyError at once, instead of queueing the hit.
 */
export const createRedisRateLimiter = ({ redis }: RedisRateLimiterOptions): RateLimiter => ({
  hit: async (key, { requests, windowSeconds }) => {
    if (!redis.client.isReady)
      throw new RedisNotReadyError();

    const redisKey = `${redis.prefix}${rateLimitKeyPrefix}${key}`;
    const [count, , ttl] = await redis.client.multi()
      .incr(redisKey)
      .expire(redisKey, windowSeconds, 'NX')
      .ttl(redisKey)
      .exec() as unknown as [number, number, number];

    return {
      allowed: count <= requests,
      retryAfterSeconds: Math.max(1, ttl),
    };
  },
});
