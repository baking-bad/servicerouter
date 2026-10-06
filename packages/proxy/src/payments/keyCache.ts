import type { PaymentKey } from '@servicerouter/core';
import type { KeyStore } from '@servicerouter/payments';

export interface KeyCacheSettings {
  readonly maxKeys: number;
  // How long a key stays. Key events drop it sooner (AK-9).
  readonly ttlMs: number;
  // How long an unknown hash stays, so random keys don't reach Postgres
  readonly missTtlMs: number;
}

export interface KeyCacheOptions extends KeyCacheSettings {
  readonly store: KeyStore;
  // Milliseconds since the epoch. Default: Date.now.
  readonly now?: () => number;
  // Counts hits and misses (XC-2)
  readonly onLookup?: (result: 'hit' | 'miss') => void;
}

/** The proxy's payment keys by hash, cached briefly (PR-4, AK-9). */
export interface KeyCache extends KeyStore {
  /** Drops the key with this ID after a change (AK-9). Lookups already running aren't cached. */
  invalidate(keyId: string): void;
  /** Drops every key, such as after key events may have been missed. */
  clear(): void;
  readonly size: number;
}

interface Entry {
  readonly key: PaymentKey | undefined;
  readonly expiresAt: number;
}

/**
 * An in-process LRU of payment keys by hash, in front of the KeyStore. Concurrent misses for one hash
 * load once. A key event drops the key, and any lookup that started before it isn't cached, so the
 * next request after a revocation never sees the old key (AK-9).
 */
export const createKeyCache = ({ store, now = Date.now, maxKeys, ttlMs, missTtlMs, onLookup }: KeyCacheOptions): KeyCache => {
  // Map order is the LRU order: the first hash is the least recently used
  const entries = new Map<string, Entry>();
  // Key ID → hash, so an event by ID finds its entry
  const hashes = new Map<string, string>();
  const pending = new Map<string, { promise: Promise<PaymentKey | undefined> }>();
  // Bumped by every invalidation and clear: a lookup that started before one isn't cached
  let epoch = 0;

  const remove = (hash: string): void => {
    const entry = entries.get(hash);
    entries.delete(hash);
    if (entry?.key && hashes.get(entry.key.id) === hash)
      hashes.delete(entry.key.id);
  };

  const keep = (hash: string, key: PaymentKey | undefined): void => {
    remove(hash);
    entries.set(hash, { key, expiresAt: now() + (key ? ttlMs : missTtlMs) });
    if (key)
      hashes.set(key.id, hash);
    for (const [oldest] of entries) {
      if (entries.size <= maxKeys)
        break;
      remove(oldest);
    }
  };

  const load = (hash: string): Promise<PaymentKey | undefined> => {
    const started = epoch;
    const record = {} as { promise: Promise<PaymentKey | undefined> };
    record.promise = (async () => {
      try {
        const key = await store.findByHash(hash);
        if (started === epoch)
          keep(hash, key);

        return key;
      }
      finally {
        // A later lookup may have replaced it after an invalidation
        if (pending.get(hash) === record)
          pending.delete(hash);
      }
    })();
    pending.set(hash, record);

    return record.promise;
  };

  return {
    findByHash: async hash => {
      const cached = entries.get(hash);
      if (cached && cached.expiresAt > now()) {
        // Most recently used goes last
        entries.delete(hash);
        entries.set(hash, cached);
        onLookup?.('hit');

        return cached.key;
      }
      if (cached)
        remove(hash);

      onLookup?.('miss');

      return pending.get(hash)?.promise ?? load(hash);
    },
    invalidate: keyId => {
      epoch += 1;
      // A lookup running now may have read the old key: later requests start their own
      pending.clear();
      const hash = hashes.get(keyId);
      if (hash !== undefined)
        remove(hash);
    },
    clear: () => {
      epoch += 1;
      pending.clear();
      entries.clear();
      hashes.clear();
    },
    get size() {
      return entries.size;
    },
  };
};
