import { and, eq, isNull } from 'drizzle-orm';

import type { ApiKeyRecord, ApiKeyRepository } from '@servicerouter/core';

import type { DatabaseExecutor } from './postgres.js';
import { apiKeys } from './schema/accounts.js';

export interface ApiKeyRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
}

// Every column except the hash, which never leaves the repository
const recordColumns = {
  id: apiKeys.id,
  accountId: apiKeys.accountId,
  kind: apiKeys.kind,
  label: apiKeys.label,
  createdAt: apiKeys.createdAt,
  revokedAt: apiKeys.revokedAt,
};

type RecordRow = { [Column in keyof typeof recordColumns]: typeof apiKeys.$inferSelect[Column] };

const toRecord = (row: RecordRow): ApiKeyRecord => ({
  id: row.id,
  accountId: row.accountId,
  kind: row.kind,
  label: row.label ?? undefined,
  createdAt: row.createdAt,
  revokedAt: row.revokedAt ?? undefined,
});

/** The `api_keys` table. Stores and looks up keys by their SHA-256 hash only (AK-3). */
export const createApiKeyRepository = ({ db }: ApiKeyRepositoryOptions): ApiKeyRepository => ({
  insert: async ({ id, accountId, kind, keyHash, label, createdAt }) => {
    const [row] = await db.insert(apiKeys)
      .values({ id, accountId, kind, keyHash, label: label ?? null, createdAt })
      .returning(recordColumns);

    return toRecord(row!);
  },
  findActiveByHash: async keyHash => {
    const [row] = await db.select(recordColumns).from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)));

    return row ? toRecord(row) : undefined;
  },
  revoke: async ({ id, accountId, revokedAt }) => {
    const [row] = await db.update(apiKeys)
      .set({ revokedAt })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.accountId, accountId), isNull(apiKeys.revokedAt)))
      .returning(recordColumns);

    return row ? toRecord(row) : undefined;
  },
});
