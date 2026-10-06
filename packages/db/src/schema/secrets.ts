import { sql } from 'drizzle-orm';
import { check, pgTable, primaryKey, smallint, text, timestamp } from 'drizzle-orm/pg-core';

import { bytea } from './columns.js';
import { services } from './services.js';

// Owned by Secrets. One row per secret of a service, sealed for the proxy (SC-2). Never a value.
export const serviceSecrets = pgTable('service_secrets', {
  serviceId: text('service_id').notNull().references(() => services.id),
  name: text('name').notNull(),
  // The SealedSecret fields
  version: smallint('version').notNull(),
  keyId: text('key_id').notNull(),
  wrappedKey: bytea('wrapped_key').notNull(),
  iv: bytea('iv').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  tag: bytea('tag').notNull(),
  // The upstream origin the secret is sealed for, in clear, so the Platform API checks SC-10 without
  // opening it. The proxy never opens with it: it uses the compiled runtime's origin.
  origin: text('origin').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  primaryKey({ name: 'service_secrets_pkey', columns: [table.serviceId, table.name] }),
  check('service_secrets_origin_check', sql`${table.origin} like 'https://%'`),
]);
