import { setTimeout as sleep } from 'node:timers/promises';

import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createLogger } from '@servicerouter/common';
import type { InvalidationEvent } from '@servicerouter/core';
import { auditLog, createAuditLogRepository, createRedisInvalidationBus } from '@servicerouter/db';

import { createFakeClock, createFakeIdGenerator, createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '../../src/index.js';

const rounds = 10;

/**
 * Run by two test files at once. Both write the same audit IDs, the same key name, and events on the
 * same channel name, so a shared database or prefix would show up as a duplicate key or a foreign value.
 */
export const describeIsolation = (label: string): void => {
  let database: TestDatabase;
  let redis: TestRedis;

  beforeAll(async () => {
    [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  });

  afterAll(async () => {
    await Promise.all([database?.drop(), redis?.cleanup()]);
  });

  it(`sees only its own rows, keys, and messages (${label})`, async () => {
    const audit = createAuditLogRepository({ db: database.db, clock: createFakeClock(), ids: createFakeIdGenerator() });
    const bus = createRedisInvalidationBus({ redis, logger: createLogger({ level: 'silent' }) });
    const received: InvalidationEvent[] = [];
    await bus.subscribe(event => {
      received.push(event);
    });

    try {
      for (let round = 1; round <= rounds; round++) {
        await audit.append({ actor: { kind: 'job', id: label }, action: 'test.round', subject: { kind: 'test', id: label }, details: { round } });
        await redis.client.set(`${redis.prefix}marker`, `${label}-${round}`);
        await bus.publish({ kind: 'service', id: label });
        // Gives the other file time to write in between
        await sleep(10);

        expect(await redis.client.get(`${redis.prefix}marker`)).toBe(`${label}-${round}`);
      }

      const rows = await database.db.select().from(auditLog);
      expect(rows).toHaveLength(rounds);
      expect(rows.every(row => row.actorId === label)).toBe(true);
      await vi.waitFor(() => expect(received).toHaveLength(rounds));
      expect(received.every(event => event.id === label)).toBe(true);
    }
    finally {
      await bus.close();
    }
  });
};
