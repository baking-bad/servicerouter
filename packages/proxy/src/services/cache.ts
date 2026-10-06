/** What a load found: a value, or nothing to serve, which is cached for a shorter time. */
export type CacheLoad<TValue> =
  | { readonly kind: 'value'; readonly value: TValue }
  | { readonly kind: 'none' };

export interface RuntimeCacheOptions<TValue> {
  /** Loads one entry. A rejection reaches every request waiting for it and caches nothing. */
  load(id: string): Promise<CacheLoad<TValue>>;
  /** Frees a value once no request uses it, such as destroying its secrets (SC-5). */
  dispose(value: TValue): void;
  // Milliseconds since the epoch. Default: Date.now.
  readonly now?: () => number;
  readonly maxEntries: number;
  // How long a value stays: the safety net behind invalidation (PX-3)
  readonly ttlMs: number;
  // How long "nothing to serve" stays, so random IDs don't reach Postgres (PX-3)
  readonly noneTtlMs: number;
  // Counts hits and misses, for the hit rate (XC-2)
  readonly onLookup?: (result: 'hit' | 'miss') => void;
}

/** A use of an entry. Release it when done; the value is disposed only once nobody holds it. */
export interface Lease<TValue> {
  readonly found: CacheLoad<TValue>;
  release(): void;
}

interface Entry<TValue> {
  readonly found: CacheLoad<TValue>;
  readonly expiresAt: number;
  leases: number;
  retired: boolean;
  disposed: boolean;
}

interface Pending<TValue> {
  // Requests waiting for the load. Each gets a lease when it completes.
  waiters: number;
  promise: Promise<Entry<TValue>>;
}

export interface RuntimeCache<TValue> {
  /** The entry for an ID, loading it on a miss. Concurrent misses for one ID load once. */
  acquire(id: string): Promise<Lease<TValue>>;
  /** Drops one entry (SR-7). A load already running for it isn't cached. */
  invalidate(id: string): void;
  /** Drops every entry, such as after events may have been missed. */
  clear(): void;
  readonly size: number;
}

/**
 * The proxy's runtime cache (PX-3): an in-process LRU by service ID, with a TTL. A value leaves the
 * cache on invalidation, expiry, or eviction, and is disposed once the last request using it lets go,
 * so a request never sees secrets destroyed under it (SC-5).
 */
export const createRuntimeCache = <TValue>({
  load,
  dispose,
  now = Date.now,
  maxEntries,
  ttlMs,
  noneTtlMs,
  onLookup,
}: RuntimeCacheOptions<TValue>): RuntimeCache<TValue> => {
  // Map order is the LRU order: the first key is the least recently used
  const entries = new Map<string, Entry<TValue>>();
  const pending = new Map<string, Pending<TValue>>();
  // Bumped by invalidate and clear, so a load that started before one isn't cached
  const generations = new Map<string, number>();
  let epoch = 0;

  const free = (entry: Entry<TValue>): void => {
    if (entry.disposed || entry.leases > 0 || !entry.retired)
      return;

    entry.disposed = true;
    if (entry.found.kind === 'value')
      dispose(entry.found.value);
  };
  const retire = (entry: Entry<TValue>): void => {
    entry.retired = true;
    free(entry);
  };
  const remove = (id: string): void => {
    const entry = entries.get(id);
    if (!entry)
      return;

    entries.delete(id);
    retire(entry);
  };
  const lease = (entry: Entry<TValue>): Lease<TValue> => {
    let released = false;

    return {
      found: entry.found,
      release: () => {
        if (released)
          return;

        released = true;
        entry.leases -= 1;
        free(entry);
      },
    };
  };

  const loadEntry = async (id: string, record: Pending<TValue>): Promise<Entry<TValue>> => {
    const started = { epoch, generation: generations.get(id) ?? 0 };
    let found: CacheLoad<TValue>;
    try {
      found = await load(id);
    }
    finally {
      pending.delete(id);
    }

    // Every request that joined the load holds a lease from here on
    const entry: Entry<TValue> = {
      found,
      expiresAt: now() + (found.kind === 'value' ? ttlMs : noneTtlMs),
      leases: record.waiters,
      retired: false,
      disposed: false,
    };
    if (started.epoch !== epoch || started.generation !== (generations.get(id) ?? 0)) {
      // Invalidated while loading: serve the requests that waited, but don't keep it
      entry.retired = true;
      return entry;
    }

    remove(id);
    entries.set(id, entry);
    for (const [oldest] of entries) {
      if (entries.size <= maxEntries)
        break;
      remove(oldest);
    }

    return entry;
  };

  return {
    acquire: async id => {
      const cached = entries.get(id);
      if (cached && cached.expiresAt > now()) {
        // Most recently used goes last
        entries.delete(id);
        entries.set(id, cached);
        cached.leases += 1;
        onLookup?.('hit');

        return lease(cached);
      }
      if (cached)
        remove(id);

      onLookup?.('miss');
      let record = pending.get(id);
      if (!record) {
        const created = { waiters: 0 } as Pending<TValue>;
        created.promise = loadEntry(id, created);
        pending.set(id, created);
        record = created;
      }
      record.waiters += 1;

      return lease(await record.promise);
    },
    invalidate: id => {
      generations.set(id, (generations.get(id) ?? 0) + 1);
      remove(id);
    },
    clear: () => {
      epoch += 1;
      generations.clear();
      for (const id of [...entries.keys()])
        remove(id);
    },
    get size() {
      return entries.size;
    },
  };
};
