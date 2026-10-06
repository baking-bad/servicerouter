import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, Secret } from '@servicerouter/common';
import { createTestDatabase, type TestDatabase } from '@servicerouter/testing';

import { createPostgres, withTransaction } from '../../src/index.js';

const logger = createLogger({ level: 'silent' });
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.db.execute(sql`create table notes (id text primary key)`);
});

afterAll(async () => {
  await database?.drop();
});

const noteIds = async (): Promise<readonly string[]> => {
  const { rows } = await database.db.execute<{ id: string }>(sql`select id from notes order by id`);

  return rows.map(row => row.id);
};

describe('createPostgres', () => {
  it('pings the server, and close is idempotent', async () => {
    const postgres = createPostgres({ url: database.url, logger });

    await expect(postgres.ping()).resolves.toBeUndefined();
    await Promise.all([postgres.close(), postgres.close()]);
    await expect(postgres.ping()).rejects.toThrow();
  });

  it('fails the ping when the server is unreachable', async () => {
    const postgres = createPostgres({ url: Secret.from('postgres://nobody:secret@127.0.0.1:1/none'), logger });

    await expect(postgres.ping()).rejects.toThrow();
    await postgres.close();
  });
});

describe('withTransaction', () => {
  it('commits every write in the callback together', async () => {
    await withTransaction(database.db, async tx => {
      await tx.execute(sql`insert into notes values ('commit-1')`);
      await tx.execute(sql`insert into notes values ('commit-2')`);
    });

    expect(await noteIds()).toEqual(expect.arrayContaining(['commit-1', 'commit-2']));
  });

  it('rolls back every write when the callback throws', async () => {
    const failure = withTransaction(database.db, async tx => {
      await tx.execute(sql`insert into notes values ('rollback-1')`);
      throw new Error('stop');
    });

    await expect(failure).rejects.toThrow('stop');
    expect(await noteIds()).not.toContain('rollback-1');
  });

  it('opens a savepoint inside a transaction', async () => {
    await withTransaction(database.db, async tx => {
      await tx.execute(sql`insert into notes values ('outer')`);
      await expect(withTransaction(tx, async inner => {
        await inner.execute(sql`insert into notes values ('inner')`);
        throw new Error('inner failed');
      })).rejects.toThrow('inner failed');
    });

    const ids = await noteIds();

    expect(ids).toContain('outer');
    expect(ids).not.toContain('inner');
  });
});

describe('tryAdvisoryLock (WK-1)', () => {
  it('gives the lock to one session at a time, and to the next once it is unlocked', async () => {
    const [first, second] = [createPostgres({ url: database.url, logger }), createPostgres({ url: database.url, logger })];
    try {
      const unlock = await first.tryAdvisoryLock(41);

      expect(unlock).toBeTypeOf('function');
      expect(await second.tryAdvisoryLock(41)).toBeUndefined();
      // Another lock ID is free
      const other = await second.tryAdvisoryLock(42);
      expect(other).toBeTypeOf('function');

      await Promise.all([unlock!(), unlock!()]);
      const next = await second.tryAdvisoryLock(41);
      expect(next).toBeTypeOf('function');
      await Promise.all([next!(), other!()]);
    }
    finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('frees the lock when its holder\'s session ends, as after a crash, and logs the lost connection', async () => {
    const lines: Record<string, unknown>[] = [];
    const watched = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const [holder, waiting] = [createPostgres({ url: database.url, logger: watched }), createPostgres({ url: database.url, logger })];
    try {
      const unlock = await holder.tryAdvisoryLock(43);
      expect(unlock).toBeTypeOf('function');
      // End the holder's session from the server, as a crash or a network failure would
      await database.db.execute(sql`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and objid = 43`);

      await expect.poll(async () => {
        const next = await waiting.tryAdvisoryLock(43);
        await next?.();

        return next !== undefined;
      }).toBe(true);
      await expect.poll(() => lines.some(line => line['msg'] === 'An advisory lock\'s connection failed, so the lock is gone' && line['lockId'] === 43)).toBe(true);
      // Unlocking a lost lock gives the dead connection back without throwing
      await expect(unlock!()).resolves.toBeUndefined();
    }
    finally {
      await Promise.all([holder.close(), waiting.close()]);
    }
  });
});
