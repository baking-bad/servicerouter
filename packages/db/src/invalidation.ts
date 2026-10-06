import type { Logger } from '@servicerouter/common';
import {
  isInvalidationEvent, type InvalidationBus, type InvalidationEvent, type InvalidationHandler,
} from '@servicerouter/core';

import { closeRedisClient, type Redis, type RedisClient } from './redis.js';

// The channel name after the connection's prefix
export const invalidationChannel = 'invalidation';

export interface RedisInvalidationBusOptions {
  readonly redis: Redis;
  readonly logger: Logger;
}

export interface RedisInvalidationBus extends InvalidationBus {
  /** Drops every handler and closes the subscriber connection. Publishing keeps working. */
  close(): Promise<void>;
}

const parse = (message: string): InvalidationEvent | undefined => {
  try {
    const value: unknown = JSON.parse(message);

    return isInvalidationEvent(value) ? { kind: value.kind, id: value.id } : undefined;
  }
  catch {
    return undefined;
  }
};

/**
 * The invalidation channel on Redis pub/sub (S1-D1). Publishes on the shared connection and subscribes
 * on a connection of its own, opened on the first subscribe.
 */
export const createRedisInvalidationBus = ({ redis, logger }: RedisInvalidationBusOptions): RedisInvalidationBus => {
  const channel = `${redis.prefix}${invalidationChannel}`;
  const handlers = new Set<InvalidationHandler>();
  let subscriber: Promise<RedisClient> | undefined;

  const run = async (handler: InvalidationHandler, event: InvalidationEvent): Promise<void> => {
    try {
      await handler(event);
    }
    catch (error) {
      logger.error({ error, event }, 'Invalidation handler failed');
    }
  };
  const deliver = (message: string): void => {
    const event = parse(message);
    if (!event) {
      logger.warn({ channel }, 'Ignored a malformed invalidation message');
      return;
    }
    for (const handler of handlers)
      void run(handler, event);
  };
  const subscribeChannel = async (): Promise<RedisClient> => {
    const client = redis.duplicate();
    try {
      await client.subscribe(channel, deliver);
    }
    catch (error) {
      await closeRedisClient(client);
      throw error;
    }

    return client;
  };

  return {
    publish: async event => {
      await redis.client.publish(channel, JSON.stringify({ kind: event.kind, id: event.id }));
    },
    subscribe: async handler => {
      subscriber ??= subscribeChannel();
      try {
        await subscriber;
      }
      catch (error) {
        subscriber = undefined;
        throw error;
      }
      handlers.add(handler);

      return async () => {
        handlers.delete(handler);
      };
    },
    close: async () => {
      handlers.clear();
      const pending = subscriber;
      subscriber = undefined;
      if (!pending)
        return;

      try {
        await closeRedisClient(await pending);
      }
      catch {
        // The subscription never started, so there is nothing to close
      }
    },
  };
};
