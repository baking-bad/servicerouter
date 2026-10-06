import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@servicerouter/common';
import { createTestDatabase, type TestDatabase } from '@servicerouter/testing';

import { migrateDatabase } from '../../src/index.js';

const logger = createLogger({ level: 'silent' });
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
});

afterAll(async () => {
  await database?.drop();
});

const tables = async (): Promise<readonly string[]> => {
  const { rows } = await database.db.execute<{ name: string }>(sql`select table_name as name from information_schema.tables where table_schema = 'public' order by table_name`);

  return rows.map(row => row.name);
};

describe('migrateDatabase', () => {
  it('applies every migration to an empty database, and a second run is a no-op', async () => {
    expect(await tables()).toEqual([]);

    const applied = await migrateDatabase({ url: database.url, logger });

    expect(applied).toBeGreaterThan(0);
    expect(await tables()).toContain('audit_log');
    expect(await migrateDatabase({ url: database.url, logger })).toBe(0);
  });

  it('applies each migration once when two runs race', async () => {
    const fresh = await createTestDatabase({ migrate: false });
    try {
      const results = await Promise.all([
        migrateDatabase({ url: fresh.url, logger }),
        migrateDatabase({ url: fresh.url, logger }),
      ]);

      expect(Math.min(...results)).toBe(0);
      expect(Math.max(...results)).toBeGreaterThan(0);
    }
    finally {
      await fresh.drop();
    }
  });
});
