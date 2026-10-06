import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import type { Logger, Secret } from '@servicerouter/common';

import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** What a repository takes: the database, or a transaction it joins. */
export type DatabaseExecutor = Database | DatabaseTransaction;

export interface PostgresOptions {
  // DATABASE_URL. It carries the password, so it stays in a Secret and is never logged.
  readonly url: Secret;
  readonly logger: Logger;
}

export interface Postgres {
  readonly db: Database;
  /** Readiness: one round trip to the server. */
  ping(): Promise<void>;
  /** Waits for running queries, then closes every connection. */
  close(): Promise<void>;
}

/** Connects lazily: the pool opens connections on the first query. */
export const createPostgres = ({ url, logger }: PostgresOptions): Postgres => {
  const pool = new pg.Pool({ connectionString: url.expose() });
  // An idle connection failed. The pool drops it; without a listener the process would crash.
  pool.on('error', error => logger.error({ error }, 'Postgres connection error'));
  let closing: Promise<void> | undefined;

  return {
    db: drizzle({ client: pool, schema }),
    ping: async () => {
      await pool.query('select 1');
    },
    close: () => closing ??= pool.end(),
  };
};

/**
 * Runs `work` in one transaction, so several repositories commit or roll back together. Inside a
 * transaction it opens a savepoint instead. Throwing from `work` rolls back.
 */
export const withTransaction = async <TResult>(
  executor: DatabaseExecutor,
  work: (tx: DatabaseTransaction) => Promise<TResult>,
): Promise<TResult> => executor.transaction(work);
