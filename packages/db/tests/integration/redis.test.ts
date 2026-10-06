import { once } from 'node:events';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, Secret } from '@servicerouter/common';
import { createTestRedis, type TestRedis } from '@servicerouter/testing';

import { closeRedisClient, createRedis, RedisNotReadyError } from '../../src/index.js';

const logger = createLogger({ level: 'silent' });
let redis: TestRedis;

beforeAll(async () => {
  redis = await createTestRedis();
});

afterAll(async () => {
  await redis?.cleanup();
});

describe('createRedis', () => {
  it('pings the server once connected, and close is idempotent', async () => {
    const connection = createRedis({ url: redis.url, logger, prefix: redis.prefix });
    await once(connection.client, 'ready');

    await expect(connection.ping()).resolves.toBeUndefined();
    expect(connection.prefix).toBe(redis.prefix);
    await Promise.all([connection.close(), connection.close()]);
    await expect(connection.ping()).rejects.toThrow(RedisNotReadyError);
  });

  it('fails the ping at once while it can\'t connect, and still closes', async () => {
    const connection = createRedis({ url: Secret.from('redis://:secret@127.0.0.1:1'), logger });

    await expect(connection.ping()).rejects.toThrow(RedisNotReadyError);
    await connection.close();
    expect(connection.client.isOpen).toBe(false);
  });

  it('opens a second connection with the same settings', async () => {
    const other = redis.duplicate();
    try {
      await other.set(`${redis.prefix}shared`, 'value');

      expect(await redis.client.get(`${redis.prefix}shared`)).toBe('value');
    }
    finally {
      await closeRedisClient(other);
    }
  });
});
