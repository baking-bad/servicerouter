import pg from 'pg';
import { describe, expect, it } from 'vitest';

import type { Secret } from '@servicerouter/common';

import { createTestDatabase } from '../../src/index.js';

const query = async <TRow extends pg.QueryResultRow>(url: string, text: string, values: readonly unknown[] = []): Promise<readonly TRow[]> => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<TRow>(text, [...values])).rows;
  }
  finally {
    await client.end();
  }
};

const databaseExists = async (name: string): Promise<boolean> =>
  (await query(process.env['TEST_DATABASE_URL']!, 'select 1 from pg_database where datname = $1', [name])).length === 1;

const tables = async (url: Secret): Promise<readonly string[]> =>
  (await query<{ name: string }>(url.expose(), `select table_name as name from information_schema.tables where table_schema = 'public'`)).map(row => row.name);

describe('createTestDatabase', () => {
  it('creates a separate, migrated database each time, and drop removes it', async () => {
    const [first, second] = await Promise.all([createTestDatabase(), createTestDatabase()]);
    try {
      expect(first.name).not.toBe(second.name);
      expect(await tables(first.url)).toContain('audit_log');
      await query(first.url.expose(), 'create table only_in_first (id int)');
      expect(await tables(second.url)).not.toContain('only_in_first');
      await expect(first.postgres.ping()).resolves.toBeUndefined();
    }
    finally {
      await Promise.all([first.drop(), second.drop(), first.drop()]);
    }

    expect(await databaseExists(first.name)).toBe(false);
    expect(await databaseExists(second.name)).toBe(false);
  // About 2 s alone, past 5 s under the full suite's load: two databases created and migrated at once (D-23)
  }, 30_000);

  it('creates an empty database on request', async () => {
    const database = await createTestDatabase({ migrate: false });
    try {
      expect(await tables(database.url)).toEqual([]);
    }
    finally {
      await database.drop();
    }
  });
});
