import { once } from 'node:events';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, Secret } from '@servicerouter/common';
import { createTestRedis, type TestRedis } from '@servicerouter/testing';

import { createRedis, createRedisReplayStore, RedisNotReadyError, type Redis } from '../../src/index.js';

let redis: TestRedis;
// A second connection with the same prefix: another proxy replica on the same Redis
let replica: Redis;

beforeAll(async () => {
  redis = await createTestRedis();
  replica = createRedis({ url: redis.url, logger: createLogger({ level: 'silent' }), prefix: redis.prefix });
  await once(replica.client, 'ready');
});

afterAll(async () => {
  await replica?.close();
  await redis?.cleanup();
});

const inOneMinute = () => Date.now() + 60_000;

describe('the MPP replay store (PR-9, section 5)', () => {
  it('claims a credential once across replicas, under <prefix>mpp: until the claim expires', async () => {
    const first = createRedisReplayStore({ redis });
    const second = createRedisReplayStore({ redis: replica });
    const expires = inOneMinute();

    const claims = await Promise.all([first.tryClaim('mppx:charge:0xabc', expires), second.tryClaim('mppx:charge:0xabc', expires)]);

    expect([...claims].sort()).toEqual([false, true]);
    expect(await second.tryClaim('mppx:charge:0xabc', expires)).toBe(false);
    const key = `${redis.prefix}mpp:mppx:charge:0xabc`;
    expect(JSON.parse((await redis.client.get(key))!)).toEqual({ expires, type: 'mppx:replay' });
    const ttl = await redis.client.pTTL(key);
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('claims a key again once the first claim has expired', async () => {
    const store = createRedisReplayStore({ redis });

    expect(await store.tryClaim('mppx:charge:0xdef', Date.now() + 50)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(await store.tryClaim('mppx:charge:0xdef', inOneMinute())).toBe(true);
  });

  it('refuses a claim without a valid expiry', async () => {
    const store = createRedisReplayStore({ redis });

    await expect(store.tryClaim('mppx:charge:0x1', Number.NaN)).rejects.toThrow(RangeError);
    await expect(store.tryClaim('mppx:charge:0x1', 0)).rejects.toThrow(RangeError);
  });

  it('gets, puts, and deletes JSON values', async () => {
    const store = createRedisReplayStore({ redis });

    expect(await store.get('value')).toBeNull();
    await store.put('value', { count: 1, tags: ['a'] });
    expect(await replica.client.get(`${redis.prefix}mpp:value`)).toBe('{"count":1,"tags":["a"]}');
    expect(await store.get('value')).toEqual({ count: 1, tags: ['a'] });
    await store.delete('value');
    expect(await store.get('value')).toBeNull();
  });

  it('updates atomically across replicas: no change is lost', async () => {
    const first = createRedisReplayStore({ redis });
    const second = createRedisReplayStore({ redis: replica });
    const increment = (store: typeof first) => store.update('counter', current => ({
      op: 'set' as const,
      value: (typeof current === 'number' ? current : 0) + 1,
      result: undefined,
    }));

    try {
      await Promise.all(Array.from({ length: 20 }, (_, index) => increment(index % 2 === 0 ? first : second)));

      expect(await first.get('counter')).toBe(20);
      expect(await first.update('counter', current => ({ op: 'noop', result: current }))).toBe(20);
      expect(await second.update('counter', () => ({ op: 'delete', result: 'gone' }))).toBe('gone');
      expect(await first.get('counter')).toBeNull();
    }
    finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('throws RedisNotReadyError at once while Redis is disconnected, so nothing is taken unclaimed', async () => {
    const closed = createRedis({ url: Secret.from('redis://127.0.0.1:1'), logger: createLogger({ level: 'silent' }), prefix: redis.prefix });
    const store = createRedisReplayStore({ redis: closed });

    try {
      await expect(store.tryClaim('mppx:charge:0x2', inOneMinute())).rejects.toThrow(RedisNotReadyError);
      await expect(store.get('value')).rejects.toThrow(RedisNotReadyError);
      await expect(store.update('value', () => ({ op: 'noop', result: undefined }))).rejects.toThrow(RedisNotReadyError);
    }
    finally {
      await closed.close();
    }
  });
});
