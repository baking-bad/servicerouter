import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@servicerouter/common';
import type { InvalidationEvent } from '@servicerouter/core';
import { createTestRedis, type TestRedis } from '@servicerouter/testing';

import { createRedis, createRedisInvalidationBus, invalidationChannel, type Redis, type RedisInvalidationBus } from '../../src/index.js';

const logger = createLogger({ level: 'silent' });
let redis: TestRedis;
const opened: Redis[] = [];
const buses: RedisInvalidationBus[] = [];

beforeAll(async () => {
  redis = await createTestRedis();
});

afterAll(async () => {
  await Promise.all(buses.map(bus => bus.close()));
  await Promise.all(opened.map(connection => connection.close()));
  await redis?.cleanup();
});

// A bus on its own connection, as another replica would have
const createBus = (prefix = redis.prefix): RedisInvalidationBus => {
  const connection = createRedis({ url: redis.url, logger, prefix });
  opened.push(connection);
  const bus = createRedisInvalidationBus({ redis: connection, logger });
  buses.push(bus);

  return bus;
};

const collect = async (bus: RedisInvalidationBus): Promise<InvalidationEvent[]> => {
  const events: InvalidationEvent[] = [];
  await bus.subscribe(event => {
    events.push(event);
  });

  return events;
};

describe('Redis invalidation bus', () => {
  it('delivers a published event to a subscriber on another connection', async () => {
    const publisher = createBus();
    const received = await collect(createBus());

    await publisher.publish({ kind: 'service', id: 'my-app' });
    await publisher.publish({ kind: 'key', id: 'key_1' });

    await vi.waitFor(() => expect(received).toEqual([{ kind: 'service', id: 'my-app' }, { kind: 'key', id: 'key_1' }]));
  });

  it('keeps prefixes apart: an event under one prefix doesn\'t reach a subscriber under another', async () => {
    const otherPrefix = `${redis.prefix}other:`;
    const publisher = createBus();
    const otherPublisher = createBus(otherPrefix);
    const received = await collect(createBus());
    const otherReceived = await collect(createBus(otherPrefix));

    await publisher.publish({ kind: 'account', id: 'acc_1' });
    await vi.waitFor(() => expect(received).toEqual([{ kind: 'account', id: 'acc_1' }]));
    // Redis delivers in publish order, so if the first event had leaked it would arrive before this one
    await otherPublisher.publish({ kind: 'account', id: 'acc_2' });

    await vi.waitFor(() => expect(otherReceived).toEqual([{ kind: 'account', id: 'acc_2' }]));
    expect(received).toEqual([{ kind: 'account', id: 'acc_1' }]);
  });

  it('delivers to every handler, survives a failing handler, and stops after unsubscribe', async () => {
    const publisher = createBus();
    const subscriber = createBus();
    const first: InvalidationEvent[] = [];
    const second: InvalidationEvent[] = [];
    await subscriber.subscribe(() => {
      throw new Error('handler failed');
    });
    const unsubscribe = await subscriber.subscribe(event => {
      first.push(event);
    });
    await subscriber.subscribe(async event => {
      second.push(event);
    });

    await publisher.publish({ kind: 'service', id: 'one' });
    await vi.waitFor(() => expect(second).toHaveLength(1));
    await unsubscribe();
    await publisher.publish({ kind: 'service', id: 'two' });

    await vi.waitFor(() => expect(second).toHaveLength(2));
    expect(first).toEqual([{ kind: 'service', id: 'one' }]);
  });

  it('ignores malformed messages and keeps delivering', async () => {
    const subscriber = createBus();
    const received = await collect(subscriber);
    const channel = `${redis.prefix}${invalidationChannel}`;

    await redis.client.publish(channel, 'not json');
    await redis.client.publish(channel, JSON.stringify({ kind: 'payment', id: 'p_1' }));
    await redis.client.publish(channel, JSON.stringify({ kind: 'service', id: '' }));
    await redis.client.publish(channel, JSON.stringify({ kind: 'service', id: 'kept', extra: true }));

    await vi.waitFor(() => expect(received).toEqual([{ kind: 'service', id: 'kept' }]));
  });

  it('stops delivering after close, and can still publish', async () => {
    const subscriber = createBus();
    const received = await collect(subscriber);
    const watcher = await collect(createBus());

    await subscriber.close();
    await subscriber.publish({ kind: 'key', id: 'after-close' });

    await vi.waitFor(() => expect(watcher).toEqual([{ kind: 'key', id: 'after-close' }]));
    expect(received).toEqual([]);
  });
});
