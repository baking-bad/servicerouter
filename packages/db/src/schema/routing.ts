import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, index, integer, pgTable, primaryKey, text, timestamp,
} from 'drizzle-orm/pg-core';

import { payments } from './ledger.js';

// Owned by Payment routing. Times come from the Clock port (CK-5).

// A paid endpoint the proxy routed to (RT-13): the host and path, and its own fee, if any
export const routedEndpoints = pgTable('routed_endpoints', {
  host: text('host').notNull(),
  path: text('path').notNull(),
  // Null: routingFeeBps from platform config
  feeBps: integer('fee_bps'),
  // The last quote in micro-USD (the target's price and the fee), for the catalog (CI-2)
  lastPrice: bigint('last_price', { mode: 'bigint' }),
  // The first routed call
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  primaryKey({ name: 'routed_endpoints_pkey', columns: [table.host, table.path] }),
  check('routed_endpoints_fee_check', sql`${table.feeBps} is null or (${table.feeBps} >= 0 and ${table.feeBps} <= 10000)`),
]);

// Hosts the proxy refuses to route to (RT-18)
export const hostBlocklist = pgTable('host_blocklist', {
  host: text('host').primaryKey(),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
});

export type TargetPaymentStatus = 'signed' | 'settled' | 'failed' | 'unknown';

// The target leg of a routed call (RT-11): what the platform paid the target for one buyer payment
export const targetPayments = pgTable('target_payments', {
  paymentId: text('payment_id').primaryKey().references(() => payments.id),
  protocol: text('protocol').$type<'x402' | 'mpp'>().notNull(),
  network: text('network').notNull(),
  // The registry's asset name
  asset: text('asset').notNull(),
  // The target's price in micro-USD, and in the asset's atomic units
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  atomicAmount: bigint('atomic_amount', { mode: 'bigint' }).notNull(),
  payTo: text('pay_to').notNull(),
  // The Signer's record of the signature (SG-7)
  signatureId: text('signature_id').notNull(),
  status: text('status').$type<TargetPaymentStatus>().notNull(),
  // The target's settlement answer, such as its PAYMENT-RESPONSE, and the transaction it names
  receipt: text('receipt'),
  transactionHash: text('transaction_hash'),
  // The target kept our payment while the buyer wasn't charged (RT-9)
  lossBooked: boolean('loss_booked').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  index('target_payments_status_idx').on(table.status, table.createdAt),
  check('target_payments_amount_check', sql`${table.amount} > 0 and ${table.atomicAmount} > 0`),
  check('target_payments_status_check', sql`${table.status} in ('signed', 'settled', 'failed', 'unknown')`),
]);

// Owned by the Signer: every signature it made (SG-7)
export const signatures = pgTable('signatures', {
  id: text('id').primaryKey(),
  requestId: text('request_id'),
  quoteId: text('quote_id').notNull(),
  protocol: text('protocol').$type<'x402' | 'mpp'>().notNull(),
  network: text('network').notNull(),
  asset: text('asset').notNull(),
  // The asset's atomic units, and micro-USD
  atomicAmount: bigint('atomic_amount', { mode: 'bigint' }).notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  payTo: text('pay_to').notNull(),
  resource: text('resource').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  index('signatures_network_created_idx').on(table.network, table.createdAt),
]);
