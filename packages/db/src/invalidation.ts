import type { Logger } from '@servicerouter/common';
import {
  isInvalidationEvent, type InvalidationBus, type InvalidationEvent, type InvalidationHandler, type InvalidationSubscribeOptions,
} from '@servicerouter/core';

import { closeRedisClient, type Redis, type RedisClient } from './redis.js';

// The channel name after the connection's prefix
export const invalidationChannel = 'invalidation';

export interface RedisInvalidationBusOptions {
  readonly redis: Redis;
  readonly logger: Logger;
}

export interface RedisInvalidationBus extends InvalidationBus {
  /**
   * Drops every handler and closes the subscriber connection, even one still connecting. Publishing
   * keeps working.
   */
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

type ReconnectHandler = NonNullable<InvalidationSubscribeOptions['onReconnect']>;

interface Subscriber {
  readonly client: RedisClient;
  // Settles once the channel is subscribed, or the subscription failed
  readonly subscribed: Promise<void>;
}

/**
 * The invalidation channel on Redis pub/sub (S1-D1). Publishes on the shared connection and subscribes
 * on a connection of its own, opened on the first subscribe and named `<prefix>invalidation`. The
 * client subscribes again after a drop before it reports ready, so each later ready event tells
 * `onReconnect` handlers that events may have been missed.
 */
export const createRedisInvalidationBus = ({ redis, logger }: RedisInvalidationBusOptions): RedisInvalidationBus => {
  const channel = `${redis.prefix}${invalidationChannel}`;
  const handlers = new Set<InvalidationHandler>();
  const reconnectHandlers = new Set<ReconnectHandler>();
  let subscriber: Subscriber | undefined;

  const run = async (handler: InvalidationHandler, event: InvalidationEvent): Promise<void> => {
    try {
      await handler(event);
    }
    catch (error) {
      logger.error({ error, event }, 'Invalidation handler failed');
    }
  };
  const reconnected = (): void => {
    logger.warn({ channel }, 'The invalidation subscriber reconnected; events published meanwhile were missed');
    for (const handler of reconnectHandlers) {
      void (async () => {
        try {
          await handler();
        }
        catch (error) {
          logger.error({ error }, 'Invalidation reconnect handler failed');
        }
      })();
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
  // Closing a subscriber that is still connecting makes its subscribe fail, and closing it again is a no-op
  const closeQuietly = async (client: RedisClient): Promise<void> => {
    try {
      await closeRedisClient(client);
    }
    catch {
      // Already closed
    }
  };
  const subscribeChannel = (): Subscriber => {
    const client = redis.duplicate({ name: channel });
    const subscribed = (async () => {
      try {
        await client.subscribe(channel, deliver);
      }
      catch (error) {
        await closeQuietly(client);
        throw error;
      }
      // A subscribe sent while connecting completes during the handshake, before the first ready event.
      // That one is the first connection; every later one is a reconnect.
      let connecting = !client.isReady;
      client.on('ready', () => {
        if (connecting)
          connecting = false;
        else
          reconnected();
      });
    })();

    return { client, subscribed };
  };

  return {
    publish: async event => {
      await redis.client.publish(channel, JSON.stringify({ kind: event.kind, id: event.id }));
    },
    subscribe: async (handler, { onReconnect } = {}) => {
      subscriber ??= subscribeChannel();
      const current = subscriber;
      try {
        await current.subscribed;
      }
      catch (error) {
        if (subscriber === current)
          subscriber = undefined;
        throw error;
      }
      handlers.add(handler);
      if (onReconnect)
        reconnectHandlers.add(onReconnect);

      return async () => {
        handlers.delete(handler);
        if (onReconnect)
          reconnectHandlers.delete(onReconnect);
      };
    },
    close: async () => {
      handlers.clear();
      reconnectHandlers.clear();
      const current = subscriber;
      subscriber = undefined;
      // Never waits for a subscription that can't connect: closing the client ends it
      if (current)
        await closeQuietly(current.client);
    },
  };
};
