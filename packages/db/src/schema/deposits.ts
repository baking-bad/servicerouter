import { sql } from 'drizzle-orm';
import {
  bigint, check, index, integer, json, pgSequence, pgTable, primaryKey, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';

import type { DepositStatus } from '@servicerouter/core';

import { accounts } from './accounts.js';

// Owned by Deposits. Times come from the Clock port (CK-5).

// The HD wallet index of each new deposit address (DP-1). A value taken by a failed insert is skipped.
export const depositAddressIndex = pgSequence('deposit_address_index', { startWith: 0, minValue: 0 });

// One Cardano address per account, derived from the account public key at its index (DP-1)
export const depositAddresses = pgTable('deposit_addresses', {
  accountId: text('account_id').primaryKey().references(() => accounts.id),
  derivationIndex: integer('derivation_index').notNull(),
  address: text('address').notNull(),
  // The network it was derived for, such as cardano:mainnet
  network: text('network').notNull(),
  // AK-15: the top-up link's own random token
  topupToken: text('topup_token').notNull(),
  // The block height the next scan starts from (DP-2)
  scannedHeight: integer('scanned_height').notNull().default(0),
  // The chain's tip at the last scan, for the deposits' confirmations (DP-5)
  tipHeight: integer('tip_height'),
  nextCheckAt: timestamp('next_check_at', { withTimezone: true, precision: 3 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  uniqueIndex('deposit_addresses_index_idx').on(table.derivationIndex),
  uniqueIndex('deposit_addresses_address_idx').on(table.address),
  uniqueIndex('deposit_addresses_topup_token_idx').on(table.topupToken),
  index('deposit_addresses_next_check_idx').on(table.nextCheckAt),
  check('deposit_addresses_index_check', sql`${table.derivationIndex} >= 0`),
]);

// Every output to a deposit address, once by transaction and output (DP-3)
export const deposits = pgTable('deposits', {
  txHash: text('tx_hash').notNull(),
  outputIndex: integer('output_index').notNull(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  address: text('address').notNull(),
  // Of the deposit asset, in its atomic units. 0 when the output holds none.
  quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
  // What it credits, in micro-USD (DP-4). Null for an output without the deposit asset.
  usdAmount: bigint('usd_amount', { mode: 'bigint' }),
  // Every amount of the output, by Blockfrost unit, as decimal strings
  amounts: json('amounts').$type<Record<string, string>>().notNull(),
  blockHeight: integer('block_height').notNull(),
  blockTime: timestamp('block_time', { withTimezone: true, precision: 3 }).notNull(),
  status: text('status').$type<DepositStatus>().notNull(),
  // The ledger transaction that credited it
  ledgerTransactionId: text('ledger_transaction_id'),
  seenAt: timestamp('seen_at', { withTimezone: true, precision: 3 }).notNull(),
  creditedAt: timestamp('credited_at', { withTimezone: true, precision: 3 }),
}, table => [
  primaryKey({ name: 'deposits_pkey', columns: [table.txHash, table.outputIndex] }),
  index('deposits_account_idx').on(table.accountId, table.seenAt),
  index('deposits_address_status_idx').on(table.address, table.status),
  check('deposits_status_check', sql`${table.status} in ('pending', 'credited', 'not_credited', 'dropped')`),
  check('deposits_credit_check', sql`${table.status} <> 'credited' or (${table.usdAmount} > 0 and ${table.ledgerTransactionId} is not null)`),
]);
