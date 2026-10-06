import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';

import { createLogger, Secret } from '@servicerouter/common';
import {
  createPostgres, migrateDatabase, migrationsFolder, type Database, type Postgres,
} from '@servicerouter/db';

const testDatabasePrefix = 'servicerouter_test_';
const testDatabasePattern = /^servicerouter_test_([0-9a-z]+)_[0-9a-f]+$/;
const templatePrefix = 'servicerouter_template_';
// Test databases older than this were left behind by an interrupted run
const staleAfterMs = 24 * 60 * 60 * 1000;
// Serializes template builds across test files and concurrent runs
const templateLockId = 7_301_746_118;

const silentLogger = createLogger({ level: 'silent' });
const quote = pg.escapeIdentifier;

export interface TestDatabase {
  readonly name: string;
  // This database's URL, for code under test that opens its own connections
  readonly url: Secret;
  readonly postgres: Postgres;
  readonly db: Database;
  /** Closes `postgres` and drops the database. */
  drop(): Promise<void>;
}

const readServerUrl = (): URL => {
  const value = process.env['TEST_DATABASE_URL'];
  if (!value)
    throw new Error('TEST_DATABASE_URL is not set. Copy .env.example to .env and run docker compose up -d');

  return new URL(value);
};

const databaseUrl = (server: URL, name: string): Secret => {
  const url = new URL(server);
  url.pathname = `/${name}`;

  return Secret.from(url.href);
};

const withServer = async <TResult>(server: URL, work: (client: pg.Client) => Promise<TResult>): Promise<TResult> => {
  const client = new pg.Client({ connectionString: server.href });
  try {
    await client.connect();
  }
  catch (error) {
    throw new Error('Can\'t connect to TEST_DATABASE_URL. Is docker compose up?', { cause: error });
  }
  try {
    return await work(client);
  }
  finally {
    await client.end();
  }
};

// Every migration file. A template is built once per set of migrations and reused by later runs.
const hashMigrations = async (): Promise<string> => {
  const entries = await readdir(migrationsFolder, { recursive: true, withFileTypes: true });
  const files = entries
    .filter(entry => entry.isFile() && /\.(?:sql|json)$/.test(entry.name))
    .map(entry => path.relative(migrationsFolder, path.join(entry.parentPath, entry.name)))
    .sort();
  const contents = await Promise.all(files.map(file => readFile(path.join(migrationsFolder, file))));
  const hash = createHash('sha256');
  files.forEach((file, index) => hash.update(file).update(contents[index]!));

  return hash.digest('hex').slice(0, 16);
};

const dropStaleDatabases = async (client: pg.Client): Promise<void> => {
  const { rows } = await client.query<{ name: string }>('select datname as name from pg_database where datname like $1', [`${testDatabasePrefix}%`]);
  const stale = rows.map(row => row.name).filter(name => {
    const createdAt = testDatabasePattern.exec(name)?.[1];

    return createdAt !== undefined && Date.now() - parseInt(createdAt, 36) > staleAfterMs;
  });
  await Promise.all(stale.map(name => client.query(`drop database if exists ${quote(name)} with (force)`)));
};

const prepareTemplate = async (server: URL): Promise<string> => {
  const name = `${templatePrefix}${await hashMigrations()}`;

  return withServer(server, async client => {
    await client.query('select pg_advisory_lock($1)', [templateLockId]);
    await dropStaleDatabases(client);
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (rowCount === 0) {
      // Built under another name and renamed when complete, so a failed build never leaves a broken template
      const building = `${name}_building`;
      await client.query(`drop database if exists ${quote(building)} with (force)`);
      await client.query(`create database ${quote(building)}`);
      await migrateDatabase({ url: databaseUrl(server, building), logger: silentLogger });
      await client.query(`alter database ${quote(building)} rename to ${quote(name)}`);
    }

    return name;
  });
};

export interface TestDatabaseOptions {
  // false: an empty database, for tests of the migrations themselves. Default: true.
  readonly migrate?: boolean;
}

let template: Promise<string> | undefined;

/**
 * A fresh database with every migration applied, for one test file. It is cloned from a template
 * database, so migrations run once per migration set, not once per file. Needs TEST_DATABASE_URL: a
 * role that may create databases.
 */
export const createTestDatabase = async ({ migrate = true }: TestDatabaseOptions = {}): Promise<TestDatabase> => {
  const server = readServerUrl();
  const source = migrate ? await (template ??= prepareTemplate(server)) : 'template0';
  const name = `${testDatabasePrefix}${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  await withServer(server, client => client.query(`create database ${quote(name)} template ${quote(source)}`));

  const url = databaseUrl(server, name);
  const postgres = createPostgres({ url, logger: silentLogger });
  const dropDatabase = async (): Promise<void> => {
    await postgres.close();
    await withServer(server, client => client.query(`drop database if exists ${quote(name)} with (force)`));
  };
  let dropping: Promise<void> | undefined;

  return {
    name,
    url,
    postgres,
    db: postgres.db,
    drop: () => dropping ??= dropDatabase(),
  };
};
