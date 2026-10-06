import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

import type { ServiceDocumentKind } from '@servicerouter/core';

import { serviceRevisions } from './services.js';

// Owned by Agent docs: one set per revision (AD-4), made again when what they're made from changes
export const serviceDocuments = pgTable('service_documents', {
  serviceId: text('service_id').notNull(),
  revision: integer('revision').notNull(),
  kind: text('kind').$type<ServiceDocumentKind>().notNull(),
  content: text('content').notNull(),
  etag: text('etag').notNull(),
  // The hash of everything the document is made from: the revision, platform URLs, prices, generator version
  inputsHash: text('inputs_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  primaryKey({ name: 'service_documents_pkey', columns: [table.serviceId, table.revision, table.kind] }),
  foreignKey({
    name: 'service_documents_revision_fk',
    columns: [table.serviceId, table.revision],
    foreignColumns: [serviceRevisions.serviceId, serviceRevisions.number],
  }),
  check('service_documents_kind_check', sql`${table.kind} in ('openapi.json', 'llms.txt', 'skill.md', 'bazaar.json')`),
]);
