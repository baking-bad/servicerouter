import { bigint, customType, doublePrecision, index, integer, json, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

import type { CatalogRouteEntry } from '@servicerouter/core';

import { services } from './services.js';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

// Owned by Catalog and intents: the search index of live registered services (CI-1)
export const catalogEntries = pgTable('catalog_entries', {
  serviceId: text('service_id').primaryKey().references(() => services.id),
  revision: integer('revision').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  tags: text('tags').array().notNull(),
  links: json('links').$type<Record<string, string>>().notNull(),
  contact: json('contact').$type<Record<string, string>>().notNull(),
  // Micro-USD: the cheapest enabled route
  priceFrom: bigint('price_from', { mode: 'bigint' }).notNull(),
  methods: text('methods').array().notNull(),
  // Prices as decimal strings of micro-USD
  routes: json('routes').$type<readonly (Omit<CatalogRouteEntry, 'price'> & { price: string })[]>().notNull(),
  // Full-text search over the title, summary, description, tags, category, and route summaries (CI-5),
  // written with the entry: a generated column can't use array_to_string, which isn't immutable
  search: tsvector('search').notNull(),
  // When the service first went live in the catalog, for `newest`
  listedAt: timestamp('listed_at', { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  index('catalog_entries_category_idx').on(table.category),
  index('catalog_entries_search_idx').using('gin', table.search),
]);

// Stats per service and route over 30 days, from payments rows (CI-4). Route '' is the whole service.
export const serviceStats = pgTable('service_stats', {
  serviceId: text('service_id').notNull().references(() => services.id),
  routeKey: text('route_key').notNull(),
  calls30d: integer('calls_30d').notNull(),
  successRate: doublePrecision('success_rate').notNull(),
  p50Ms: integer('p50_ms').notNull(),
  p95Ms: integer('p95_ms').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  primaryKey({ name: 'service_stats_pkey', columns: [table.serviceId, table.routeKey] }),
]);
