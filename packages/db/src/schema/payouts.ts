import { sql } from 'drizzle-orm';
import {
  bigint, check, foreignKey, index, integer, json, pgTable, primaryKey, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';

import { accounts } from './accounts.js';
import { services } from './services.js';

// Owned by Payouts. Times come from the Clock port (CK-5).

export type PayoutRunStatus = 'awaiting_approval' | 'approved' | 'submitted' | 'confirmed' | 'failed' | 'stopped' | 'empty';
export type PayoutTransactionStatus = 'built' | 'submitted' | 'confirmed' | 'failed';
export type PayoutStatus = 'pending' | 'confirmed' | 'failed';

// One run per cutoff, the 1st of a month (PO-1, PO-4)
export const payoutRuns = pgTable('payout_runs', {
  id: text('id').primaryKey(),
  cutoff: timestamp('cutoff', { withTimezone: true, precision: 3 }).notNull(),
  status: text('status').$type<PayoutRunStatus>().notNull(),
  // The payout asset (PO-2), such as cardano-usdm
  asset: text('asset').notNull(),
  // Micro-USD, all payouts together
  total: bigint('total', { mode: 'bigint' }).notNull(),
  // Why the run stopped or failed: a fixed reason, never a key
  problem: text('problem'),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true, precision: 3 }),
  approvedBy: text('approved_by'),
}, table => [
  uniqueIndex('payout_runs_cutoff_idx').on(table.cutoff),
  index('payout_runs_status_idx').on(table.status),
  check('payout_runs_status_check', sql`${table.status} in ('awaiting_approval', 'approved', 'submitted', 'confirmed', 'failed', 'stopped', 'empty')`),
]);

// The signed transactions of a run, built before approval (PO-3, PO-6)
export const payoutTransactions = pgTable('payout_transactions', {
  runId: text('run_id').notNull().references(() => payoutRuns.id),
  index: integer('index').notNull(),
  txHash: text('tx_hash').notNull(),
  // The signed transaction, CBOR in hex: public once it is on chain, so not a secret
  cbor: text('cbor').notNull(),
  // After it, the chain refuses the transaction: one never seen by then can't land any more
  validUntil: timestamp('valid_until', { withTimezone: true, precision: 3 }).notNull(),
  status: text('status').$type<PayoutTransactionStatus>().notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true, precision: 3 }),
  finishedAt: timestamp('finished_at', { withTimezone: true, precision: 3 }),
}, table => [
  primaryKey({ name: 'payout_transactions_pkey', columns: [table.runId, table.index] }),
  uniqueIndex('payout_transactions_tx_hash_idx').on(table.txHash),
  check('payout_transactions_status_check', sql`${table.status} in ('built', 'submitted', 'confirmed', 'failed')`),
]);

// One payout per seller and payout address in a run (PO-1, PO-4)
export const payouts = pgTable('payouts', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => payoutRuns.id),
  sellerAccountId: text('seller_account_id').notNull().references(() => accounts.id),
  address: text('address').notNull(),
  // Micro-USD, and the payout asset's atomic units, 1:1
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
  transactionIndex: integer('transaction_index').notNull(),
  status: text('status').$type<PayoutStatus>().notNull(),
  // The ledger transaction that booked it (PO-7)
  ledgerTransactionId: text('ledger_transaction_id'),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true, precision: 3 }),
}, table => [
  uniqueIndex('payouts_run_seller_address_idx').on(table.runId, table.sellerAccountId, table.address),
  index('payouts_seller_idx').on(table.sellerAccountId),
  foreignKey({ name: 'payouts_transaction_fk', columns: [table.runId, table.transactionIndex], foreignColumns: [payoutTransactions.runId, payoutTransactions.index] }),
  check('payouts_amount_check', sql`${table.amount} > 0 and ${table.quantity} > 0`),
  check('payouts_status_check', sql`${table.status} in ('pending', 'confirmed', 'failed')`),
]);

// What each payout paid of each service: the next run subtracts it (PO-1)
export const payoutItems = pgTable('payout_items', {
  payoutId: text('payout_id').notNull().references(() => payouts.id),
  serviceId: text('service_id').notNull().references(() => services.id),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
}, table => [
  primaryKey({ name: 'payout_items_pkey', columns: [table.payoutId, table.serviceId] }),
  index('payout_items_service_idx').on(table.serviceId),
  check('payout_items_amount_check', sql`${table.amount} > 0`),
]);

// Owned by Treasury. A rebalancing an operator did and recorded (TR-4).
export const treasuryTransfers = pgTable('treasury_transfers', {
  reference: text('reference').primaryKey(),
  fromAsset: text('from_asset').notNull(),
  fromAmount: bigint('from_amount', { mode: 'bigint' }).notNull(),
  toAsset: text('to_asset').notNull(),
  toAmount: bigint('to_amount', { mode: 'bigint' }).notNull(),
  // The operator's transaction references: hashes or explorer links, as given
  transactions: json('transactions').$type<string[]>().notNull(),
  recordedBy: text('recorded_by').notNull(),
  ledgerTransactionId: text('ledger_transaction_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  check('treasury_transfers_amounts_check', sql`${table.fromAmount} > 0 and ${table.toAmount} > 0 and ${table.toAmount} <= ${table.fromAmount}`),
]);

// Each daily reconciliation, with what it compared (TR-5)
export const reconciliationRuns = pgTable('reconciliation_runs', {
  id: text('id').primaryKey(),
  ranAt: timestamp('ran_at', { withTimezone: true, precision: 3 }).notNull(),
  // Per asset: the ledger's view, the chain's, and the drift, in micro-USD as decimal strings
  results: json('results').$type<Record<string, { ledger: string; chain: string; drift: string; alert: boolean }>>().notNull(),
  alerts: integer('alerts').notNull(),
}, table => [
  index('reconciliation_runs_ran_at_idx').on(table.ranAt),
]);
