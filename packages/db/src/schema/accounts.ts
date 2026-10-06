import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import type { KeyKind } from '@servicerouter/core';

// Owned by Accounts and keys. IDs and times come from the IdGenerator and Clock ports (CK-5).
export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  email: text('email'),
  // Empty until email confirmation ships (step 9)
  emailConfirmedAt: timestamp('email_confirmed_at', { withTimezone: true, precision: 3 }),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
});

// Master and payment keys. Only the SHA-256 hash of a key is stored (AK-3). The limits are a payment
// key's (AK-6), in micro-USD, and empty on a master key.
export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  kind: text('kind').$type<KeyKind>().notNull(),
  keyHash: text('key_hash').notNull(),
  label: text('label'),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, precision: 3 }),
  allowance: bigint('allowance', { mode: 'bigint' }),
  dailyBudget: bigint('daily_budget', { mode: 'bigint' }),
  maxPrice: bigint('max_price', { mode: 'bigint' }),
  expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }),
}, table => [
  check('api_keys_limits_check', sql`${table.allowance} >= 0 and ${table.dailyBudget} >= 0 and ${table.maxPrice} >= 0`),
  // A payment key always has a daily budget (AR4); a master key has no limits
  check('api_keys_payment_limits_check', sql`case when ${table.kind} = 'payment' then ${table.dailyBudget} is not null
    else ${table.allowance} is null and ${table.dailyBudget} is null and ${table.maxPrice} is null and ${table.expiresAt} is null end`),
  uniqueIndex('api_keys_key_hash_idx').on(table.keyHash),
  index('api_keys_account_idx').on(table.accountId, table.kind),
  // At most one active master key per account. Signup and rotation keep it at exactly one.
  uniqueIndex('api_keys_active_master_idx').on(table.accountId).where(sql`kind = 'master' and revoked_at is null`),
  check('api_keys_kind_check', sql`${table.kind} in ('master', 'payment')`),
  check('api_keys_key_hash_check', sql`${table.keyHash} ~ '^[0-9a-f]{64}$'`),
]);
