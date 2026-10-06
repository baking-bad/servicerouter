import { and, desc, eq, isNull } from 'drizzle-orm';

import type { PaymentKey, PaymentKeyRepository } from '@servicerouter/core';

import type { DatabaseExecutor } from './postgres.js';
import { apiKeys } from './schema/accounts.js';

export interface PaymentKeyRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
}

// Every column except the hash, which never leaves the repository
const keyColumns = {
  id: apiKeys.id,
  accountId: apiKeys.accountId,
  label: apiKeys.label,
  createdAt: apiKeys.createdAt,
  revokedAt: apiKeys.revokedAt,
  allowance: apiKeys.allowance,
  dailyBudget: apiKeys.dailyBudget,
  maxPrice: apiKeys.maxPrice,
  expiresAt: apiKeys.expiresAt,
};

type KeyRow = { [Column in keyof typeof keyColumns]: typeof apiKeys.$inferSelect[Column] };

const toPaymentKey = (row: KeyRow): PaymentKey => ({
  id: row.id,
  accountId: row.accountId,
  label: row.label ?? undefined,
  createdAt: row.createdAt,
  revokedAt: row.revokedAt ?? undefined,
  allowance: row.allowance ?? undefined,
  // A CHECK keeps it set on every payment key
  dailyBudget: row.dailyBudget!,
  maxPrice: row.maxPrice ?? undefined,
  expiresAt: row.expiresAt ?? undefined,
});

const isPayment = eq(apiKeys.kind, 'payment');
const owned = (id: string, accountId: string) => and(eq(apiKeys.id, id), eq(apiKeys.accountId, accountId), isPayment);

/** Payment keys in `api_keys` (AK-6), by hash only (AK-3). Also the rails' KeyStore (PR-4). */
export const createPaymentKeyRepository = ({ db }: PaymentKeyRepositoryOptions): PaymentKeyRepository => ({
  insert: async key => {
    const [row] = await db.insert(apiKeys).values({
      id: key.id,
      accountId: key.accountId,
      kind: 'payment',
      keyHash: key.keyHash,
      label: key.label ?? null,
      createdAt: key.createdAt,
      allowance: key.allowance ?? null,
      dailyBudget: key.dailyBudget,
      maxPrice: key.maxPrice ?? null,
      expiresAt: key.expiresAt ?? null,
    }).returning(keyColumns);

    return toPaymentKey(row!);
  },
  find: async ({ id, accountId }) => {
    const [row] = await db.select(keyColumns).from(apiKeys).where(owned(id, accountId));

    return row ? toPaymentKey(row) : undefined;
  },
  list: async accountId => {
    const rows = await db.select(keyColumns).from(apiKeys)
      .where(and(eq(apiKeys.accountId, accountId), isPayment))
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));

    return rows.map(toPaymentKey);
  },
  update: async ({ id, accountId, changes }) => {
    const set = {
      ...('label' in changes ? { label: changes.label ?? null } : {}),
      ...('allowance' in changes ? { allowance: changes.allowance ?? null } : {}),
      ...(changes.dailyBudget === undefined ? {} : { dailyBudget: changes.dailyBudget }),
      ...('maxPrice' in changes ? { maxPrice: changes.maxPrice ?? null } : {}),
      ...('expiresAt' in changes ? { expiresAt: changes.expiresAt ?? null } : {}),
    };
    if (Object.keys(set).length === 0) {
      const [row] = await db.select(keyColumns).from(apiKeys).where(and(owned(id, accountId), isNull(apiKeys.revokedAt)));

      return row ? toPaymentKey(row) : undefined;
    }
    const [row] = await db.update(apiKeys).set(set).where(and(owned(id, accountId), isNull(apiKeys.revokedAt))).returning(keyColumns);

    return row ? toPaymentKey(row) : undefined;
  },
  revoke: async ({ id, accountId, revokedAt }) => {
    const [row] = await db.update(apiKeys).set({ revokedAt })
      .where(and(owned(id, accountId), isNull(apiKeys.revokedAt)))
      .returning(keyColumns);

    return row ? toPaymentKey(row) : undefined;
  },
  findActiveByHash: async keyHash => {
    const [row] = await db.select(keyColumns).from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), isPayment, isNull(apiKeys.revokedAt)));

    return row ? toPaymentKey(row) : undefined;
  },
});

/** The rails' KeyStore port (PR-4): an active payment key by hash, with its limits. */
export const createKeyStore = (options: PaymentKeyRepositoryOptions) => {
  const keys = createPaymentKeyRepository(options);

  return { findByHash: (keyHash: string) => keys.findActiveByHash(keyHash) };
};
