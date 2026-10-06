import { sql } from 'drizzle-orm';
import {
  check, foreignKey, index, integer, json, pgTable, primaryKey, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';

import type { HostProblem, HostState } from '@servicerouter/core';

import { accounts } from './accounts.js';
import { serviceRevisions, services } from './services.js';

// Owned by Ownership verification. Times come from the Clock port (CK-5).

// One token per account, created the first time it's needed and never changed (OV-1)
export const verificationTokens = pgTable('verification_tokens', {
  accountId: text('account_id').primaryKey().references(() => accounts.id),
  token: text('token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  uniqueIndex('verification_tokens_token_idx').on(table.token),
  check('verification_tokens_token_check', sql`${table.token} ~ '^sr-verify=[0-9a-f]{32}$'`),
]);

// A host's state per account (OV-3, OV-4): several accounts can verify the same host
export const upstreamHosts = pgTable('upstream_hosts', {
  accountId: text('account_id').notNull().references(() => accounts.id),
  host: text('host').notNull(),
  state: text('state').$type<HostState>().notNull(),
  // The start of the grace period, while `missing` or after it ran out
  missingSince: timestamp('missing_since', { withTimezone: true, precision: 3 }),
  checkedAt: timestamp('checked_at', { withTimezone: true, precision: 3 }),
  // Why the last check didn't find the token
  problem: text('problem').$type<HostProblem>(),
  // When the daily job checks it next (OV-6)
  nextCheckAt: timestamp('next_check_at', { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  primaryKey({ name: 'upstream_hosts_pkey', columns: [table.accountId, table.host] }),
  index('upstream_hosts_next_check_idx').on(table.nextCheckAt),
  check('upstream_hosts_state_check', sql`${table.state} in ('unverified', 'verified', 'missing', 'suspended')`),
  check('upstream_hosts_problem_check', sql`${table.problem} in ('file_not_found', 'fetch_failed', 'invalid_file', 'token_missing')`),
  check('upstream_hosts_missing_check', sql`${table.state} not in ('missing', 'suspended') or ${table.missingSince} is not null`),
]);

// A payout change waiting for its confirmation token on every host (OV-10, SR-13). One per service.
export const payoutConfirmations = pgTable('payout_confirmations', {
  serviceId: text('service_id').primaryKey().references(() => services.id),
  // The waiting revision
  revision: integer('revision').notNull(),
  token: text('token').notNull(),
  // The waiting revision's payouts, to tell whether a newer submit keeps the token (OV-10.5)
  payouts: json('payouts').notNull(),
  hosts: text('hosts').array().notNull(),
  confirmedHosts: text('confirmed_hosts').array().notNull().default(sql`'{}'`),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
  // When the daily job checks it next (OV-6)
  nextCheckAt: timestamp('next_check_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  uniqueIndex('payout_confirmations_token_idx').on(table.token),
  index('payout_confirmations_next_check_idx').on(table.nextCheckAt),
  check('payout_confirmations_token_check', sql`${table.token} ~ '^sr-confirm=[0-9a-f]{32}$'`),
  foreignKey({
    name: 'payout_confirmations_revision_fk',
    columns: [table.serviceId, table.revision],
    foreignColumns: [serviceRevisions.serviceId, serviceRevisions.number],
  }),
]);
