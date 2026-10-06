import { createClient } from 'redis';

import { ServiceRouterError, type Logger, type Secret } from '@servicerouter/common';

export type RedisClient = ReturnType<typeof createClient>;

export class RedisNotReadyError extends ServiceRouterError {
  readonly code = 'redis_not_ready';

  constructor() {
    super('Redis is not connected');
  }
}

export interface RedisOptions {
  // REDIS_URL. It carries the password, so it stays in a Secret and is never logged.
  readonly url: Secret;
  readonly logger: Logger;
  // Starts every key and channel name the adapters use, so deployments and test files that share a
  // server don't see each other. Empty by default.
  readonly prefix?: string;
}

export interface Redis {
  readonly client: RedisClient;
  readonly prefix: string;
  /** Opens another connection with the same settings, such as for a pub/sub subscriber. The caller closes it. */
  duplicate(): RedisClient;
  /** Readiness: fails at once while disconnected, otherwise one round trip to the server. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Waits for queued commands, or drops them if the client never connected. */
export const closeRedisClient = async (client: RedisClient): Promise<void> => {
  if (client.isReady)
    await client.close();
  else
    client.destroy();
};

/**
 * Connects in the background and keeps reconnecting, so an app starts while Redis is down and reports
 * not ready until it connects. Commands sent before then wait in the client's queue.
 */
export const createRedis = ({ url, logger, prefix = '' }: RedisOptions): Redis => {
  const open = (client: RedisClient): RedisClient => {
    // Without a listener a connection error would crash the process. The client reconnects by itself.
    client.on('error', (error: unknown) => logger.error({ error }, 'Redis connection error'));
    // Rejects only when closed while connecting. Failed attempts arrive as 'error' events.
    void client.connect().catch(() => undefined);

    return client;
  };
  const client = open(createClient({ url: url.expose() }));
  let closing: Promise<void> | undefined;

  return {
    client,
    prefix,
    duplicate: () => open(client.duplicate()),
    ping: async () => {
      if (!client.isReady)
        throw new RedisNotReadyError();

      await client.ping();
    },
    close: () => closing ??= closeRedisClient(client),
  };
};
