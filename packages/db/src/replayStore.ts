import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { WatchError } from 'redis';

import { closeRedisClient, RedisNotReadyError, type Redis, type RedisClient } from './redis.js';

// The key space after the connection's prefix (section 5: `mpp:*`)
export const replayKeyPrefix = 'mpp:';
// How often an update tries when other writers keep changing its key meanwhile. Each lost try backs
// off a few milliseconds at random, so two writers don't keep colliding.
const maxUpdateAttempts = 100;

/** A store update's outcome, as `mppx`'s `Store.Change`: keep, write, or delete the value. */
export type ReplayStoreChange<TResult> =
  | { readonly op: 'noop'; readonly result: TResult }
  | { readonly op: 'set'; readonly value: unknown; readonly result: TResult }
  | { readonly op: 'delete'; readonly result: TResult };

/**
 * The MPP replay store (PR-9): `mppx`'s `AtomicStore` on Redis, shared by every proxy replica. Values
 * are JSON. A claim is one `SET NX` with the marker's expiry, so a credential used once is refused on
 * every replica until its challenge expires.
 */
export interface RedisReplayStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Reads the value and applies `fn`'s change, retried while another writer changes the key. */
  update<TResult>(key: string, fn: (current: unknown) => ReplayStoreChange<TResult>): Promise<TResult>;
  /**
   * Records the first use of `key` until `expires` (ms since the epoch). True for the first claim,
   * false while an unexpired claim exists.
   */
  tryClaim(key: string, expires: number): Promise<boolean>;
  /** Closes the connection that updates use, if one was opened. */
  close(): Promise<void>;
}

export interface RedisReplayStoreOptions {
  readonly redis: Redis;
}

const parse = (raw: string | null): unknown => raw === null ? null : JSON.parse(raw);

/**
 * The replay store under `<prefix>mpp:` (section 5). While Redis is disconnected every call throws
 * RedisNotReadyError at once: a credential that can't be claimed is never taken.
 */
export const createRedisReplayStore = ({ redis }: RedisReplayStoreOptions): RedisReplayStore => {
  const keyOf = (key: string): string => `${redis.prefix}${replayKeyPrefix}${key}`;
  const ready = (): RedisClient => {
    if (!redis.client.isReady)
      throw new RedisNotReadyError();

    return redis.client;
  };
  // WATCH needs a connection no other command shares, so updates run one at a time on their own
  let watcher: RedisClient | undefined;
  let updates: Promise<unknown> = Promise.resolve();

  const updateOnce = async <TResult>(key: string, fn: (current: unknown) => ReplayStoreChange<TResult>): Promise<TResult> => {
    ready();
    watcher ??= redis.duplicate({ name: `${redis.prefix}${replayKeyPrefix}update` });
    const name = keyOf(key);
    for (let attempt = 1; ; attempt += 1) {
      await watcher.watch(name);
      const change = fn(parse(await watcher.get(name)));
      if (change.op === 'noop') {
        await watcher.unwatch();
        return change.result;
      }
      try {
        const transaction = watcher.multi();
        if (change.op === 'set')
          transaction.set(name, JSON.stringify(change.value));
        else
          transaction.del(name);
        await transaction.exec();

        return change.result;
      }
      catch (error) {
        if (!(error instanceof WatchError) || attempt >= maxUpdateAttempts)
          throw error;
        await sleep(randomInt(1, 2 + Math.min(attempt, 20)));
      }
    }
  };

  return {
    get: async key => parse(await ready().get(keyOf(key))),
    put: async (key, value) => {
      await ready().set(keyOf(key), JSON.stringify(value));
    },
    delete: async key => {
      await ready().del(keyOf(key));
    },
    update: (key, fn) => {
      const run = updates.then(() => updateOnce(key, fn), () => updateOnce(key, fn));
      updates = run.catch(() => undefined);

      return run;
    },
    tryClaim: async (key, expires) => {
      if (!Number.isSafeInteger(expires) || expires <= 0)
        throw new RangeError('A claim\'s expiry must be a time in milliseconds since the epoch');
      const claimed = await ready().set(keyOf(key), JSON.stringify({ expires, type: 'mppx:replay' }), {
        condition: 'NX',
        expiration: { type: 'PXAT', value: expires },
      });

      return claimed === 'OK';
    },
    close: async () => {
      if (watcher)
        await closeRedisClient(watcher);
    },
  };
};
