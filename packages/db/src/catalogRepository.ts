import { and, asc, desc, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';

import type { Clock, MicroUsd } from '@servicerouter/common';
import type { CatalogEntry, CatalogSort } from '@servicerouter/core';

import type { DatabaseExecutor } from './postgres.js';
import { catalogEntries, serviceStats } from './schema/catalog.js';
import { payments } from './schema/ledger.js';
import { routedEndpoints } from './schema/routing.js';

export interface CatalogStatsRow {
  readonly calls30d: number;
  readonly successRate: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export const emptyStats: CatalogStatsRow = Object.freeze({ calls30d: 0, successRate: 0, p50Ms: 0, p95Ms: 0 });

export interface CatalogListQuery {
  readonly category?: string;
  readonly q?: string;
  readonly method?: string;
  readonly maxPrice?: MicroUsd;
  readonly sort: CatalogSort;
  readonly limit: number;
  readonly offset: number;
}

export interface CatalogListedEntry extends CatalogEntry {
  readonly stats: CatalogStatsRow;
  readonly listedAt: Date;
  readonly updatedAt: Date;
}

export interface RoutedCatalogEntry {
  readonly host: string;
  readonly path: string;
  readonly lastPrice: MicroUsd | undefined;
  readonly createdAt: Date;
}

/** The `catalog_entries` and `service_stats` tables (Catalog), and the routed endpoints it lists (CI-2). */
export interface CatalogRepository {
  /** Makes the index exactly these entries: upserts them, and drops every other (CI-1). Keeps when each was first listed. */
  syncEntries(entries: readonly CatalogEntry[]): Promise<void>;
  /** Aggregates the last 30 days of payments into stats per service and route (CI-4). */
  computeStats(since: Date): Promise<number>;
  list(query: CatalogListQuery): Promise<{ readonly entries: readonly CatalogListedEntry[]; readonly total: number }>;
  find(serviceId: string): Promise<(CatalogListedEntry & { readonly routeStats: ReadonlyMap<string, CatalogStatsRow> }) | undefined>;
  /** Live entries per category, with the other filters applied. */
  categoryCounts(query: Omit<CatalogListQuery, 'category' | 'sort' | 'limit' | 'offset'>): Promise<ReadonlyMap<string, number>>;
  /** Routed endpoints, oldest first, for after the registered services (CI-2, AR14). */
  routed(input: { readonly q?: string; readonly maxPrice?: MicroUsd; readonly limit: number; readonly offset: number }): Promise<{ readonly entries: readonly RoutedCatalogEntry[]; readonly total: number }>;
}

const toEntry = (row: typeof catalogEntries.$inferSelect, stats: CatalogStatsRow | undefined): CatalogListedEntry => ({
  serviceId: row.serviceId,
  revision: row.revision,
  title: row.title,
  summary: row.summary,
  description: row.description,
  category: row.category,
  tags: row.tags,
  links: row.links,
  contact: row.contact,
  priceFrom: row.priceFrom as MicroUsd,
  methods: row.methods as CatalogEntry['methods'],
  routes: row.routes.map(route => ({ ...route, price: BigInt(route.price) as MicroUsd })),
  stats: stats ?? emptyStats,
  listedAt: row.listedAt,
  updatedAt: row.updatedAt,
});

const filters = (query: Omit<CatalogListQuery, 'sort' | 'limit' | 'offset'>): SQL[] => [
  ...query.category ? [sql`(${catalogEntries.category} = ${query.category} or ${catalogEntries.category} like ${`${query.category}/%`})`] : [],
  ...query.q ? [sql`${catalogEntries.search} @@ websearch_to_tsquery('english', ${query.q})`] : [],
  ...query.method ? [sql`${query.method} = any(${catalogEntries.methods})`] : [],
  ...query.maxPrice !== undefined ? [sql`${catalogEntries.priceFrom} <= ${query.maxPrice}`] : [],
];

export const createCatalogRepository = ({ db, clock }: { readonly db: DatabaseExecutor; readonly clock: Clock }): CatalogRepository => {
  const statsOf = async (serviceIds: readonly string[]): Promise<ReadonlyMap<string, CatalogStatsRow>> => {
    if (serviceIds.length === 0)
      return new Map();
    const rows = await db.select().from(serviceStats).where(and(inArray(serviceStats.serviceId, [...serviceIds]), eq(serviceStats.routeKey, '')));

    return new Map(rows.map(row => [row.serviceId, { calls30d: row.calls30d, successRate: row.successRate, p50Ms: row.p50Ms, p95Ms: row.p95Ms }]));
  };

  return {
    syncEntries: async entries => {
      const now = clock.now();
      for (const entry of entries) {
        const values = {
          revision: entry.revision, title: entry.title, summary: entry.summary, description: entry.description, category: entry.category,
          tags: [...entry.tags], links: { ...entry.links }, contact: { ...entry.contact }, priceFrom: entry.priceFrom, methods: [...entry.methods],
          routes: entry.routes.map(route => ({ ...route, methods: [...route.methods], price: route.price.toString() })), updatedAt: now,
          search: sql`to_tsvector('english', ${[entry.title, entry.summary, entry.description, ...entry.tags, entry.category, ...entry.routes.map(route => route.summary)].join(' ')})`,
        };
        await db.insert(catalogEntries).values({ serviceId: entry.serviceId, ...values, listedAt: now })
          .onConflictDoUpdate({ target: catalogEntries.serviceId, set: values });
      }
      // Suspended, pending, or gone: out of the catalog
      await db.delete(catalogEntries).where(entries.length === 0
        ? sql`true`
        : notInArray(catalogEntries.serviceId, entries.map(entry => entry.serviceId)));
    },

    computeStats: async since => {
      const now = clock.now();
      // One row per service (the whole service, route '') and per keyed route: calls with a decision,
      // the share that was billable, and the upstream latency's p50 and p95 (CI-4)
      const rows = await db.execute<{ service_id: string; route_key: string | null; whole: number; calls: string; success: string; p50: string | null; p95: string | null }>(sql`
        select ${payments.serviceId} as service_id, ${payments.routeKey} as route_key, grouping(${payments.routeKey}) as whole,
          count(*)::text as calls, (count(*) filter (where ${payments.decision} = 'billable'))::text as success,
          percentile_cont(0.5) within group (order by ${payments.upstreamLatencyMs})::text as p50,
          percentile_cont(0.95) within group (order by ${payments.upstreamLatencyMs})::text as p95
        from ${payments}
        where ${payments.kind} = 'service' and ${payments.decision} is not null and ${payments.createdAt} >= ${since}
        group by grouping sets ((${payments.serviceId}, ${payments.routeKey}), (${payments.serviceId}))`);
      const stats = rows.rows
        .filter(row => Number(row.whole) === 1 || row.route_key !== null)
        .map(row => {
          const calls = Number(row.calls);

          return {
            serviceId: row.service_id, routeKey: Number(row.whole) === 1 ? '' : row.route_key!, calls30d: calls,
            successRate: calls === 0 ? 0 : Number(row.success) / calls,
            p50Ms: Math.round(Number(row.p50 ?? 0)), p95Ms: Math.round(Number(row.p95 ?? 0)), updatedAt: now,
          };
        });
      await db.delete(serviceStats);
      if (stats.length > 0)
        await db.insert(serviceStats).values(stats);

      return stats.length;
    },

    list: async query => {
      const where = filters(query);
      const condition = where.length > 0 ? and(...where) : undefined;
      const order = {
        popular: [desc(sql`coalesce(${serviceStats.calls30d}, 0)`), asc(catalogEntries.serviceId)],
        price: [asc(catalogEntries.priceFrom), asc(catalogEntries.serviceId)],
        newest: [desc(catalogEntries.listedAt), asc(catalogEntries.serviceId)],
        success: [desc(sql`coalesce(${serviceStats.successRate}, 0)`), asc(catalogEntries.serviceId)],
      }[query.sort];
      const rows = await db.select({ entry: catalogEntries, stats: serviceStats })
        .from(catalogEntries)
        .leftJoin(serviceStats, and(eq(serviceStats.serviceId, catalogEntries.serviceId), eq(serviceStats.routeKey, '')))
        .where(condition)
        .orderBy(...order)
        .limit(query.limit)
        .offset(query.offset);
      const [counted] = await db.select({ count: sql<number>`count(*)::int` }).from(catalogEntries).where(condition);

      return {
        entries: rows.map(row => toEntry(row.entry, row.stats ? { calls30d: row.stats.calls30d, successRate: row.stats.successRate, p50Ms: row.stats.p50Ms, p95Ms: row.stats.p95Ms } : undefined)),
        total: counted?.count ?? 0,
      };
    },

    find: async serviceId => {
      const [row] = await db.select().from(catalogEntries).where(eq(catalogEntries.serviceId, serviceId));
      if (!row)
        return undefined;
      const stats = await db.select().from(serviceStats).where(eq(serviceStats.serviceId, serviceId));
      const whole = stats.find(item => item.routeKey === '');

      return {
        ...toEntry(row, whole && { calls30d: whole.calls30d, successRate: whole.successRate, p50Ms: whole.p50Ms, p95Ms: whole.p95Ms }),
        routeStats: new Map(stats.filter(item => item.routeKey !== '').map(item => [item.routeKey, {
          calls30d: item.calls30d, successRate: item.successRate, p50Ms: item.p50Ms, p95Ms: item.p95Ms,
        }])),
      };
    },

    categoryCounts: async query => {
      const where = filters(query);
      const rows = await db.select({ category: catalogEntries.category, count: sql<number>`count(*)::int` })
        .from(catalogEntries).where(where.length > 0 ? and(...where) : undefined).groupBy(catalogEntries.category);

      return new Map(rows.map(row => [row.category, row.count]));
    },

    routed: async ({ q, maxPrice, limit, offset }) => {
      const where = [
        ...q ? [sql`(${routedEndpoints.host} || ${routedEndpoints.path}) ilike ${`%${q.replace(/[%_\\]/g, '\\$&')}%`}`] : [],
        ...maxPrice !== undefined ? [sql`${routedEndpoints.lastPrice} <= ${maxPrice}`] : [],
      ];
      const condition = where.length > 0 ? and(...where) : undefined;
      const rows = await db.select().from(routedEndpoints).where(condition)
        .orderBy(asc(routedEndpoints.createdAt), asc(routedEndpoints.host), asc(routedEndpoints.path)).limit(limit).offset(offset);
      const [counted] = await db.select({ count: sql<number>`count(*)::int` }).from(routedEndpoints).where(condition);

      return {
        entries: rows.map(row => ({ host: row.host, path: row.path, lastPrice: (row.lastPrice ?? undefined) as MicroUsd | undefined, createdAt: row.createdAt })),
        total: counted?.count ?? 0,
      };
    },
  };
};
