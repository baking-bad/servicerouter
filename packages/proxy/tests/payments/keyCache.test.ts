import { describe, expect, it } from 'vitest';

import type { PaymentKey } from '@servicerouter/core';

import { createKeyCache } from '../../src/payments/keyCache.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(onResolve => {
    resolve = onResolve;
  });

  return { promise, resolve };
};

const key = (id: string, dailyBudget = 5_000_000n): PaymentKey => ({
  id,
  accountId: 'acc_1',
  label: undefined,
  createdAt: new Date('2026-10-06T19:50:00+08:00'),
  revokedAt: undefined,
  allowance: undefined,
  dailyBudget,
  maxPrice: undefined,
  expiresAt: undefined,
});

const setup = () => {
  let time = 0;
  // The store: hash → key, as Postgres has it now
  const stored = new Map<string, PaymentKey>([['hash-1', key('key_1')], ['hash-2', key('key_2')], ['hash-3', key('key_3')]]);
  const loads: string[] = [];
  const lookups: string[] = [];
  let gate: Promise<void> | undefined;
  const cache = createKeyCache({
    store: {
      findByHash: async hash => {
        loads.push(hash);
        // Read now, then wait at the gate, like a query that read the old row
        const found = stored.get(hash);
        await gate;

        return found;
      },
    },
    now: () => time,
    maxKeys: 2,
    ttlMs: 1_000,
    missTtlMs: 100,
    onLookup: result => lookups.push(result),
  });

  return {
    cache,
    stored,
    loads,
    lookups,
    advance: (ms: number) => {
      time += ms;
    },
    hold: () => {
      const opened = deferred<void>();
      gate = opened.promise;

      return () => {
        gate = undefined;
        opened.resolve();
      };
    },
  };
};

describe('the payment key cache (PR-4, AK-9)', () => {
  it('looks a hash up once, then serves it until the TTL, and counts hits and misses', async () => {
    const { cache, loads, lookups, advance } = setup();

    await cache.findByHash('hash-1');
    advance(999);
    expect(await cache.findByHash('hash-1')).toMatchObject({ id: 'key_1' });
    advance(1);
    await cache.findByHash('hash-1');

    expect(loads).toEqual(['hash-1', 'hash-1']);
    expect(lookups).toEqual(['miss', 'hit', 'miss']);
  });

  it('keeps an unknown hash for the shorter TTL, so random keys don\'t reach Postgres', async () => {
    const { cache, loads, advance } = setup();

    expect(await cache.findByHash('unknown')).toBeUndefined();
    advance(99);
    await cache.findByHash('unknown');
    advance(1);
    await cache.findByHash('unknown');

    expect(loads).toEqual(['unknown', 'unknown']);
  });

  it('loads once for concurrent lookups of one hash', async () => {
    const { cache, loads, hold } = setup();
    const open = hold();

    const lookups = [cache.findByHash('hash-1'), cache.findByHash('hash-1'), cache.findByHash('hash-1')];
    open();

    expect((await Promise.all(lookups)).map(found => found?.id)).toEqual(['key_1', 'key_1', 'key_1']);
    expect(loads).toEqual(['hash-1']);
  });

  it('drops a key by its ID when it changes, so the next lookup reads it again (AK-9)', async () => {
    const { cache, stored, loads } = setup();
    await cache.findByHash('hash-1');
    stored.delete('hash-1');

    cache.invalidate('key_1');

    expect(await cache.findByHash('hash-1')).toBeUndefined();
    expect(loads).toEqual(['hash-1', 'hash-1']);
  });

  it('doesn\'t keep a lookup that was running when its key changed, and doesn\'t let later requests join it', async () => {
    const { cache, stored, loads, hold } = setup();
    const open = hold();
    const stale = cache.findByHash('hash-1');
    // Revoked while the lookup ran: the event arrives before it ends
    stored.delete('hash-1');
    cache.invalidate('key_1');
    const fresh = cache.findByHash('hash-1');
    open();

    expect((await stale)?.id).toBe('key_1');
    expect(await fresh).toBeUndefined();
    expect(await cache.findByHash('hash-1')).toBeUndefined();
    expect(loads).toEqual(['hash-1', 'hash-1']);
  });

  it('drops everything on clear, such as after the event subscription reconnects', async () => {
    const { cache, loads } = setup();
    await cache.findByHash('hash-1');
    await cache.findByHash('hash-2');

    cache.clear();
    await cache.findByHash('hash-1');

    expect(cache.size).toBe(1);
    expect(loads).toEqual(['hash-1', 'hash-2', 'hash-1']);
  });

  it('evicts the least recently used key past its size, and its ID no longer finds it', async () => {
    const { cache, loads } = setup();
    await cache.findByHash('hash-1');
    await cache.findByHash('hash-2');
    await cache.findByHash('hash-1');

    await cache.findByHash('hash-3');
    cache.invalidate('key_2');
    await cache.findByHash('hash-1');
    await cache.findByHash('hash-2');

    expect(cache.size).toBe(2);
    expect(loads).toEqual(['hash-1', 'hash-2', 'hash-3', 'hash-2']);
  });
});
