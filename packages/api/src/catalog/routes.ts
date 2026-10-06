import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { formatUsd, parseUsd, usdAmountPattern, type Clock, type MicroUsd } from '@servicerouter/common';
import { catalogSorts, inCategory, paymentMethodsFor, type CatalogSort, type PlatformConfig } from '@servicerouter/core';
import { createCatalogRepository, emptyStats, type CatalogListedEntry, type CatalogStatsRow, type Database } from '@servicerouter/db';

import { InvalidRequestError, NotFoundError } from '../errors.js';

const defaultLimit = 20;

const listQuerySchema = {
  type: 'object',
  properties: {
    category: { type: 'string', maxLength: 64 },
    q: { type: 'string', maxLength: 200 },
    method: { type: 'string', enum: ['credits', 'x402', 'mpp'] },
    maxPrice: { type: 'string', pattern: usdAmountPattern, maxLength: 26 },
    sort: { type: 'string', enum: [...catalogSorts] },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    cursor: { type: 'string', pattern: '^[0-9]{1,9}$' },
  },
  additionalProperties: false,
} as const;

interface ListQuery {
  readonly category?: string;
  readonly q?: string;
  readonly method?: 'credits' | 'x402' | 'mpp';
  readonly maxPrice?: string;
  readonly sort?: CatalogSort;
  readonly limit?: number;
  readonly cursor?: string;
}

const toStats = (stats: CatalogStatsRow) => ({ calls30d: stats.calls30d, successRate: stats.successRate, p50Ms: stats.p50Ms, p95Ms: stats.p95Ms });

const toItem = (entry: CatalogListedEntry) => ({
  id: entry.serviceId,
  title: entry.title,
  summary: entry.summary,
  category: entry.category,
  tags: entry.tags,
  priceFrom: formatUsd(entry.priceFrom),
  currency: 'USD',
  methods: entry.methods,
  stats: toStats(entry.stats),
  verified: true,
  updatedAt: entry.updatedAt.toISOString(),
});

/**
 * The catalog (CI-1 to CI-5, CI-8): `GET /v1/catalog` and `GET /v1/catalog/{id}`, without a key, limited
 * per client IP. Live registered services first, then routed endpoints, labeled unverified (AR14).
 */
export const registerCatalogRoutes = (app: FastifyInstance, { db, config, clock, limit }: {
  readonly db: Database;
  readonly config: PlatformConfig;
  readonly clock: Clock;
  readonly limit: onRequestHookHandler;
}): void => {
  const catalog = createCatalogRepository({ db, clock });
  const api = config.urls.api.replace(/\/+$/, '');
  const pay = config.urls.pay.replace(/\/+$/, '');

  app.get<{ Querystring: ListQuery }>('/v1/catalog', { onRequest: limit, schema: { querystring: listQuerySchema } }, async request => {
    const { category, q, method, sort = 'popular', limit: pageSize = defaultLimit } = request.query;
    let maxPrice: MicroUsd | undefined;
    try {
      maxPrice = request.query.maxPrice === undefined ? undefined : parseUsd(request.query.maxPrice);
    }
    catch {
      throw new InvalidRequestError('maxPrice is too large');
    }
    const offset = Number(request.query.cursor ?? '0');
    const filters = { ...category ? { category } : {}, ...q ? { q } : {}, ...method ? { method } : {}, ...maxPrice === undefined ? {} : { maxPrice } };
    const registered = await catalog.list({ ...filters, sort, limit: pageSize, offset });
    const items: Record<string, unknown>[] = registered.entries.map(toItem);
    // Routed endpoints have no category or method of their own: they follow when neither is asked for
    const withRouted = !category && !method;
    let routedTotal = 0;
    if (withRouted) {
      const routedOffset = Math.max(0, offset - registered.total);
      const room = pageSize - items.length;
      const routed = await catalog.routed({ ...q ? { q } : {}, ...maxPrice === undefined ? {} : { maxPrice }, limit: Math.max(room, 0), offset: routedOffset });
      routedTotal = routed.total;
      if (room > 0) {
        items.push(...routed.entries.map(entry => {
          const price = (entry.lastPrice ?? 0n) as MicroUsd;

          return {
            id: `routed:${entry.host}${entry.path}`,
            title: `${entry.host}${entry.path}`,
            summary: 'A paid API that Service Router routes payments to. Unverified: its owner hasn\'t registered it.',
            category: '',
            tags: [],
            priceFrom: formatUsd(price),
            currency: 'USD',
            methods: paymentMethodsFor(price, config),
            stats: toStats(emptyStats),
            verified: false,
            updatedAt: entry.createdAt.toISOString(),
            link: `${pay}/${entry.host}${entry.path}`,
          };
        }));
      }
    }
    const total = registered.total + routedTotal;
    const counts = await catalog.categoryCounts({ ...q ? { q } : {}, ...method ? { method } : {}, ...maxPrice === undefined ? {} : { maxPrice } });

    return {
      services: items,
      categories: config.categories.map(item => ({
        id: item.id,
        title: item.title,
        count: [...counts].filter(([id]) => inCategory(id, item.id)).reduce((sum, [, count]) => sum + count, 0),
      })),
      next: offset + items.length < total && items.length > 0 ? String(offset + items.length) : null,
    };
  });

  app.get<{ Params: { readonly id: string } }>('/v1/catalog/:id', { onRequest: limit }, async request => {
    const entry = await catalog.find(request.params.id);
    if (!entry)
      throw new NotFoundError('No such service in the catalog');

    return {
      ...toItem(entry),
      description: entry.description,
      links: entry.links,
      contact: entry.contact,
      routes: entry.routes.map(route => ({
        key: route.key, method: route.method, path: route.path, summary: route.summary, price: formatUsd(route.price), methods: route.methods,
        stats: toStats(entry.routeStats.get(route.key) ?? emptyStats),
      })),
      docs: {
        openapi: `${api}/v1/services/${entry.serviceId}/openapi.json`,
        llms: `${api}/v1/services/${entry.serviceId}/llms.txt`,
        skill: `${api}/v1/services/${entry.serviceId}/skill.md`,
      },
      payUrl: `${pay}/service/${entry.serviceId}`,
    };
  });
};
