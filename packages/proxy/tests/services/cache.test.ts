import { describe, expect, it, vi } from 'vitest';

import { createRuntimeCache, type CacheLoad, type RuntimeCacheOptions } from '../../src/services/cache.js';

interface Value {
  readonly id: string;
  readonly version: number;
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });

  return { promise, resolve, reject };
};

const setup = (options: Partial<RuntimeCacheOptions<Value>> = {}) => {
  let time = 0;
  let version = 0;
  const loads: string[] = [];
  const disposed: Value[] = [];
  const lookups: string[] = [];
  const cache = createRuntimeCache<Value>({
    load: async id => {
      loads.push(id);
      version += 1;

      return id.startsWith('unknown') ? { kind: 'none' } : { kind: 'value', value: { id, version } };
    },
    dispose: value => disposed.push(value),
    now: () => time,
    maxEntries: 3,
    ttlMs: 1_000,
    noneTtlMs: 100,
    onLookup: result => lookups.push(result),
    ...options,
  });

  return { cache, loads, disposed, lookups, advance: (ms: number) => { time += ms; } };
};

const valueOf = (found: CacheLoad<Value>) => found.kind === 'value' ? found.value : undefined;

describe('the runtime cache (PX-3, SC-5)', () => {
  it('loads on a miss, then serves hits until the TTL, then loads again', async () => {
    const { cache, loads, lookups, advance } = setup();

    const first = await cache.acquire('a');
    first.release();
    advance(999);
    const second = await cache.acquire('a');
    second.release();
    advance(1);
    const third = await cache.acquire('a');
    third.release();

    expect(valueOf(first.found)).toBe(valueOf(second.found));
    expect(valueOf(third.found)?.version).toBe(2);
    expect(loads).toEqual(['a', 'a']);
    expect(lookups).toEqual(['miss', 'hit', 'miss']);
  });

  it('keeps an unknown ID for a shorter time, so random IDs don\'t reach the database each time', async () => {
    const { cache, loads, advance } = setup();

    (await cache.acquire('unknown-1')).release();
    (await cache.acquire('unknown-1')).release();
    advance(100);
    (await cache.acquire('unknown-1')).release();

    expect(loads).toEqual(['unknown-1', 'unknown-1']);
  });

  it('loads once for concurrent misses on one ID', async () => {
    const gate = deferred<CacheLoad<Value>>();
    const load = vi.fn(() => gate.promise);
    const { cache } = setup({ load });

    const waiting = [cache.acquire('a'), cache.acquire('a'), cache.acquire('a')];
    gate.resolve({ kind: 'value', value: { id: 'a', version: 1 } });
    const leases = await Promise.all(waiting);

    expect(load).toHaveBeenCalledTimes(1);
    expect(new Set(leases.map(lease => valueOf(lease.found))).size).toBe(1);
  });

  it('sends a failed load to every waiting request and caches nothing', async () => {
    const gate = deferred<CacheLoad<Value>>();
    const { cache } = setup({ load: () => gate.promise });

    const waiting = [cache.acquire('a'), cache.acquire('a')];
    gate.reject(new Error('database down'));

    await expect(Promise.all(waiting)).rejects.toThrow('database down');
    expect(cache.size).toBe(0);
  });

  it('disposes a value when it is invalidated, and loads it again on the next request (SR-7)', async () => {
    const { cache, disposed, loads } = setup();
    (await cache.acquire('a')).release();

    cache.invalidate('a');
    const next = await cache.acquire('a');

    expect(disposed).toEqual([{ id: 'a', version: 1 }]);
    expect(valueOf(next.found)?.version).toBe(2);
    expect(loads).toEqual(['a', 'a']);
  });

  it('disposes a value only when the last request using it lets go', async () => {
    const { cache, disposed } = setup();
    const inUse = await cache.acquire('a');
    const alsoInUse = await cache.acquire('a');

    cache.invalidate('a');
    expect(disposed).toEqual([]);
    inUse.release();
    inUse.release();
    expect(disposed).toEqual([]);
    alsoInUse.release();

    expect(disposed).toEqual([{ id: 'a', version: 1 }]);
  });

  it('evicts the least recently used value past its size, and disposes it', async () => {
    const { cache, disposed } = setup();
    for (const id of ['a', 'b', 'c'])
      (await cache.acquire(id)).release();
    (await cache.acquire('a')).release();

    (await cache.acquire('d')).release();

    expect(cache.size).toBe(3);
    expect(disposed).toEqual([{ id: 'b', version: 2 }]);
  });

  it('disposes an expired value when it is replaced', async () => {
    const { cache, disposed, advance } = setup();
    (await cache.acquire('a')).release();
    advance(1_000);

    (await cache.acquire('a')).release();

    expect(disposed).toEqual([{ id: 'a', version: 1 }]);
  });

  it('clears everything, disposing each value', async () => {
    const { cache, disposed } = setup();
    for (const id of ['a', 'b'])
      (await cache.acquire(id)).release();

    cache.clear();

    expect(cache.size).toBe(0);
    expect(disposed.map(value => value.id)).toEqual(['a', 'b']);
  });

  it.each([
    ['invalidated', (cache: ReturnType<typeof setup>['cache']) => cache.invalidate('a')],
    ['cleared', (cache: ReturnType<typeof setup>['cache']) => cache.clear()],
  ])('serves a load that was %s while it ran to the requests that waited, but doesn\'t keep it', async (_case, change) => {
    const gate = deferred<CacheLoad<Value>>();
    const disposed: Value[] = [];
    const { cache } = setup({ load: () => gate.promise, dispose: value => disposed.push(value) });

    const waiting = cache.acquire('a');
    change(cache);
    gate.resolve({ kind: 'value', value: { id: 'a', version: 1 } });
    const lease = await waiting;

    expect(valueOf(lease.found)).toEqual({ id: 'a', version: 1 });
    expect(cache.size).toBe(0);
    expect(disposed).toEqual([]);
    lease.release();
    expect(disposed).toEqual([{ id: 'a', version: 1 }]);
  });
});
