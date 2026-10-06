import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgTransaction } from 'drizzle-orm/pg-core';
import pg from 'pg';

import type { Logger, Secret } from '@servicerouter/common';

import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** What a repository takes: the database, or a transaction it joins. */
export type DatabaseExecutor = Database | DatabaseTransaction;

// How long the pool waits for a new connection before it fails the query (backlog D-7)
export const defaultConnectTimeoutMs = 5_000;

export interface PostgresOptions {
  // DATABASE_URL. It carries the password, so it stays in a Secret and is never logged.
  readonly url: Secret;
  readonly logger: Logger;
  // Default: 5 s. Without it, a query waits forever while Postgres accepts connections but never answers.
  readonly connectTimeoutMs?: number;
}

export interface Postgres {
  readonly db: Database;
  /** Readiness: one round trip to the server. */
  ping(): Promise<void>;
  /** Waits for running queries, then closes every connection. */
  close(): Promise<void>;
}

/** Connects lazily: the pool opens connections on the first query. */
export const createPostgres = ({ url, logger, connectTimeoutMs = defaultConnectTimeoutMs }: PostgresOptions): Postgres => {
  const pool = new pg.Pool({ connectionString: url.expose(), connectionTimeoutMillis: connectTimeoutMs });
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

/**
 * Runs `work` in a read-only transaction with one snapshot, so several reads see the same committed
 * state. Inside a transaction it joins it instead, and sees what that transaction sees.
 */
export const withSnapshot = async <TResult>(
  executor: DatabaseExecutor,
  work: (tx: DatabaseExecutor) => Promise<TResult>,
): Promise<TResult> => executor instanceof PgTransaction
  ? work(executor)
  : (executor as Database).transaction(work, { isolationLevel: 'repeatable read', accessMode: 'read only' });
