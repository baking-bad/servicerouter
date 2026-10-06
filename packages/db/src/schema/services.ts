import { sql } from 'drizzle-orm';
import {
  check, foreignKey, index, integer, json, pgTable, primaryKey, text, timestamp, type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import type { ServiceConfigDocument, ServiceState } from '@servicerouter/core';

import { accounts } from './accounts.js';

// Owned by the Service registry. Times come from the Clock port (CK-5).
export const services = pgTable('services', {
  // service.id from the config: unique and immutable
  id: text('id').primaryKey(),
  ownerAccountId: text('owner_account_id').notNull().references(() => accounts.id),
  // SR-8
  state: text('state').$type<ServiceState>().notNull(),
  // Set in the transaction that creates the service, after its first revision
  activeRevision: integer('active_revision'),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  index('services_owner_idx').on(table.ownerAccountId),
  check('services_state_check', sql`${table.state} in ('pending', 'live', 'suspended')`),
  foreignKey({
    name: 'services_active_revision_fk',
    columns: [table.id, table.activeRevision],
    foreignColumns: [serviceRevisions.serviceId, serviceRevisions.number],
  }),
]);

// Immutable (SR-4): the repository inserts and reads, never updates or deletes. JSON, not JSONB, so the
// config and the OpenAPI documents keep their key order.
export const serviceRevisions = pgTable('service_revisions', {
  serviceId: text('service_id').notNull().references((): AnyPgColumn => services.id),
  // 1, 2, 3, … per service
  number: integer('number').notNull(),
  // The config as the seller sent it, and its media type
  configText: text('config_text').notNull(),
  configMediaType: text('config_media_type').notNull(),
  // The parsed config, for compiling. Secret names only, never values (SR-12).
  config: json('config').$type<ServiceConfigDocument>().notNull(),
  // The OpenAPI documents fetched at submit time, keyed by link (SR-3)
  openapiDocuments: json('openapi_documents').$type<Record<string, unknown>>().notNull(),
  createdBy: text('created_by').notNull().references(() => accounts.id),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  primaryKey({ name: 'service_revisions_pkey', columns: [table.serviceId, table.number] }),
  check('service_revisions_number_check', sql`${table.number} >= 1`),
]);
