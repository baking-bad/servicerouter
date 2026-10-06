import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

import { createLogger, Secret } from '@servicerouter/common';
import { createRedis, type Redis } from '@servicerouter/db';

const readyTimeoutMs = 5_000;

export interface TestRedis extends Redis {
  // TEST_REDIS_URL, for code under test that opens its own connections with `prefix`
  readonly url: Secret;
  /** Deletes every key under the prefix, then closes the connection. */
  cleanup(): Promise<void>;
}

/**
 * A Redis connection with a unique prefix, for one test file. Adapters built on it put the prefix on
 * every key and channel, so test files that run in parallel don't see each other's keys or messages.
 */
export const createTestRedis = async (): Promise<TestRedis> => {
  const value = process.env['TEST_REDIS_URL'];
  if (!value)
    throw new Error('TEST_REDIS_URL is not set. Copy .env.example to .env and run docker compose up -d');

  const url = Secret.from(value);
  const prefix = `test:${randomBytes(6).toString('hex')}:`;
  const redis = createRedis({ url, logger: createLogger({ level: 'silent' }), prefix });
  try {
    await once(redis.client, 'ready', { signal: AbortSignal.timeout(readyTimeoutMs) });
  }
  catch (error) {
    await redis.close();
    throw new Error('Can\'t connect to TEST_REDIS_URL. Is docker compose up?', { cause: error });
  }

  const deleteKeys = async (): Promise<void> => {
    for await (const keys of redis.client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
      if (keys.length > 0)
        await redis.client.unlink(keys);
    }
    await redis.close();
  };
  let cleaning: Promise<void> | undefined;

  return {
    ...redis,
    url,
    cleanup: () => cleaning ??= deleteKeys(),
  };
};

/**
 * Drops every server connection with this CLIENT SETNAME name, as a network failure would. The clients
 * reconnect on their own. Returns how many connections it dropped.
 */
export const dropRedisConnections = async (redis: Redis, name: string): Promise<number> => {
  const list = await redis.client.sendCommand(['CLIENT', 'LIST']) as string;
  const ids = list.split('\n')
    .map(line => Object.fromEntries(line.trim().split(' ').map(field => field.split('=', 2) as [string, string])))
    .filter(fields => fields['name'] === name)
    .map(fields => fields['id']!);
  await Promise.all(ids.map(id => redis.client.sendCommand(['CLIENT', 'KILL', 'ID', id])));

  return ids.length;
};
