import { once } from 'node:events';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, Secret } from '@servicerouter/common';
import { createTestRedis, type TestRedis } from '@servicerouter/testing';

import { closeRedisClient, createRedis, createRedisRateLimiter, RedisNotReadyError } from '../../src/index.js';

let redis: TestRedis;

beforeAll(async () => {
  redis = await createTestRedis();
});

afterAll(async () => {
  await redis?.cleanup();
});

describe('createRedisRateLimiter (PA-5)', () => {
  it('allows the limit in a window, then refuses with the seconds left', async () => {
    const limiter = createRedisRateLimiter({ redis });
    const limit = { requests: 3, windowSeconds: 60 };

    const decisions = [];
    for (let hit = 0; hit < 5; hit += 1)
      decisions.push(await limiter.hit('api:signup:192.0.2.1', limit));

    expect(decisions.map(decision => decision.allowed)).toEqual([true, true, true, false, false]);
    expect(decisions[4]!.retryAfterSeconds).toBeGreaterThan(0);
    expect(decisions[4]!.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('keeps the counter under <prefix>rl:<key>, expiring with the window', async () => {
    const limiter = createRedisRateLimiter({ redis });

    await limiter.hit('api:signup:192.0.2.2', { requests: 10, windowSeconds: 30 });

    const key = `${redis.prefix}rl:api:signup:192.0.2.2`;
    expect(await redis.client.get(key)).toBe('1');
    const ttl = await redis.client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('counts each key on its own', async () => {
    const limiter = createRedisRateLimiter({ redis });
    const limit = { requests: 1, windowSeconds: 60 };

    expect((await limiter.hit('api:signup:192.0.2.3', limit)).allowed).toBe(true);
    expect((await limiter.hit('api:signup:192.0.2.4', limit)).allowed).toBe(true);
    expect((await limiter.hit('api:signup:192.0.2.3', limit)).allowed).toBe(false);
  });

  it('allows exactly the limit under concurrent hits from several connections', async () => {
    const second = redis.duplicate();
    await once(second, 'ready');
    const limiters = [createRedisRateLimiter({ redis }), createRedisRateLimiter({ redis: { ...redis, client: second } })];
    try {
      const decisions = await Promise.all(Array.from({ length: 40 }, (_, index) =>
        limiters[index % 2]!.hit('api:signup:192.0.2.5', { requests: 7, windowSeconds: 60 })));

      expect(decisions.filter(decision => decision.allowed)).toHaveLength(7);
    }
    finally {
      await closeRedisClient(second);
    }
  });

  it('starts a new window when the old one expires', async () => {
    const limiter = createRedisRateLimiter({ redis });
    const limit = { requests: 1, windowSeconds: 1 };

    expect((await limiter.hit('api:signup:192.0.2.6', limit)).allowed).toBe(true);
    expect((await limiter.hit('api:signup:192.0.2.6', limit)).allowed).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 1_100));

    expect((await limiter.hit('api:signup:192.0.2.6', limit)).allowed).toBe(true);
  });

  it('fails at once while Redis is disconnected, instead of waiting for it', async () => {
    // Port 1 refuses connections, so the client keeps reconnecting
    const down = createRedis({ url: Secret.from('redis://127.0.0.1:1'), logger: createLogger({ level: 'silent' }) });
    try {
      await expect(createRedisRateLimiter({ redis: down }).hit('api:signup:192.0.2.7', { requests: 1, windowSeconds: 60 }))
        .rejects.toThrow(RedisNotReadyError);
    }
    finally {
      await down.close();
    }
  });
});
