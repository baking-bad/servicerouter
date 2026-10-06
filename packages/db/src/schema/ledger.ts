import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, customType, date, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';

import type { BillingDecision, PaymentKind, PaymentStatus, RailName } from '@servicerouter/core';

import { accounts, apiKeys } from './accounts.js';
import { services } from './services.js';

// Owned by the Ledger. Amounts are integer micro-USD (LG-1). IDs and times come from the IdGenerator
// and Clock ports (CK-5).

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
};

// An on-chain amount in an asset's atomic units, which can pass a bigint for 18-decimal assets
const atomicAmount = customType<{ data: bigint; driverData: string }>({
  dataType: () => 'numeric(78, 0)',
  toDriver: value => value.toString(),
  fromDriver: value => BigInt(value),
});

/**
 * One account of the double-entry ledger: an account's available, held, earned, or paid-out money, or
 * a platform account such as fees or deposits clearing. IDs are readable: `<account ID>:available`,
 * `platform:fees`.
 */
export const ledgerAccounts = pgTable('ledger_accounts', {
  id: text('id').primaryKey(),
  // The account it belongs to, or none for a platform account
  accountId: text('account_id').references(() => accounts.id),
  type: text('type').notNull(),
  ...timestamps,
}, table => [
  index('ledger_accounts_account_idx').on(table.accountId),
]);

/**
 * Each ledger account's balance, updated in the transaction that posts its entries (LG-2). Only an
 * account that is a source of money, such as deposits clearing, may go below zero.
 */
export const balances = pgTable('balances', {
  ledgerAccountId: text('ledger_account_id').primaryKey().references(() => ledgerAccounts.id),
  balance: bigint('balance', { mode: 'bigint' }).notNull(),
  mayGoNegative: boolean('may_go_negative').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  check('balances_not_negative_check', sql`${table.mayGoNegative} or ${table.balance} >= 0`),
]);

/**
 * One movement of money, keyed by its operation and reference (a payment ID, or an operator's
 * reference), so a retry never moves money twice (LG-3, rule 4).
 */
export const ledgerTransactions = pgTable('ledger_transactions', {
  id: text('id').primaryKey(),
  // credit, hold, capture, release, …
  operation: text('operation').notNull(),
  reference: text('reference').notNull(),
  requestId: text('request_id'),
  ...timestamps,
}, table => [
  uniqueIndex('ledger_transactions_operation_reference_idx').on(table.operation, table.reference),
]);

/** The entries of a transaction. They sum to zero (LG-2). An amount adds to its account's balance. */
export const ledgerEntries = pgTable('ledger_entries', {
  id: text('id').primaryKey(),
  transactionId: text('transaction_id').notNull().references(() => ledgerTransactions.id),
  ledgerAccountId: text('ledger_account_id').notNull().references(() => ledgerAccounts.id),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
}, table => [
  index('ledger_entries_transaction_idx').on(table.transactionId),
  index('ledger_entries_account_idx').on(table.ledgerAccountId),
  check('ledger_entries_amount_check', sql`${table.amount} <> 0`),
]);

/** Every paid call (LG-7). The source of truth for seller earnings on every rail (LG-8). */
export const payments = pgTable('payments', {
  id: text('id').primaryKey(),
  requestId: text('request_id'),
  kind: text('kind').$type<PaymentKind>().notNull(),
  rail: text('rail').$type<RailName>().notNull(),
  buyerAccountId: text('buyer_account_id').references(() => accounts.id),
  keyId: text('key_id').references(() => apiKeys.id),
  sellerAccountId: text('seller_account_id').references(() => accounts.id),
  serviceId: text('service_id').references(() => services.id),
  routeKey: text('route_key'),
  targetHost: text('target_host'),
  targetPath: text('target_path'),
  network: text('network'),
  asset: text('asset'),
  atomicAmount: atomicAmount('atomic_amount'),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  fee: bigint('fee', { mode: 'bigint' }),
  decision: text('decision').$type<BillingDecision>(),
  upstreamStatus: integer('upstream_status'),
  upstreamLatencyMs: integer('upstream_latency_ms'),
  status: text('status').$type<PaymentStatus>().notNull(),
  transactionHash: text('transaction_hash'),
  receipt: text('receipt'),
  needsReview: boolean('needs_review').notNull(),
  ...timestamps,
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  index('payments_buyer_idx').on(table.buyerAccountId, table.createdAt, table.id),
  index('payments_service_idx').on(table.serviceId, table.status),
  index('payments_status_idx').on(table.status, table.createdAt),
  check('payments_kind_check', sql`${table.kind} in ('service', 'routed')`),
  check('payments_rail_check', sql`${table.rail} in ('credits', 'x402', 'mpp')`),
  check('payments_status_check', sql`${table.status} in ('held', 'verified', 'captured', 'settling', 'settled', 'released', 'cancelled', 'failed')`),
  check('payments_decision_check', sql`${table.decision} in ('billable', 'not_billable')`),
  check('payments_amounts_check', sql`${table.amount} >= 0 and ${table.fee} >= 0 and ${table.fee} <= ${table.amount}`),
]);

/** A key's spend per UTC day (LG-6, AR5). A hold adds, a release gives back. */
export const keyDailySpend = pgTable('key_daily_spend', {
  keyId: text('key_id').notNull().references(() => apiKeys.id),
  day: date('day', { mode: 'string' }).notNull(),
  spent: bigint('spent', { mode: 'bigint' }).notNull(),
}, table => [
  primaryKey({ name: 'key_daily_spend_pkey', columns: [table.keyId, table.day] }),
  check('key_daily_spend_spent_check', sql`${table.spent} >= 0`),
]);

/** A key's spend over its life, for its allowance (LG-6, AK-7). */
export const keyTotalSpend = pgTable('key_total_spend', {
  keyId: text('key_id').primaryKey().references(() => apiKeys.id),
  spent: bigint('spent', { mode: 'bigint' }).notNull(),
}, table => [
  check('key_total_spend_spent_check', sql`${table.spent} >= 0`),
]);
