import { catalogSorts, paymentMethods, type CatalogCategory, type CatalogItem, type CatalogQuery, type CatalogSort, type PaymentMethod } from '../api/types';
import { parseUsd } from '../money';

// The catalog's query (CI-5): what /discover keeps in its URL, and what GET /v1/catalog takes.

export const defaultSort: CatalogSort = 'popular';
export const defaultPageSize = 24;
const maxQueryLength = 100;

export type SearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

const first = (value: string | readonly string[] | undefined): string | undefined => {
  const text = (typeof value === 'string' ? value : value?.[0])?.trim();

  return text === '' ? undefined : text;
};

const categoryPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/** The query from a URL's parameters. A value that doesn't fit is left out, not an error: the page still lists. */
export const parseCatalogQuery = (params: SearchParams): CatalogQuery => {
  const category = first(params['category']);
  const q = first(params['q'])?.slice(0, maxQueryLength);
  const method = first(params['method']);
  const maxPrice = first(params['maxPrice']);
  const sort = first(params['sort']);
  const cursor = first(params['cursor']);

  return {
    ...(category && categoryPattern.test(category) ? { category } : {}),
    ...(q ? { q } : {}),
    ...(method && (paymentMethods as readonly string[]).includes(method) ? { method: method as PaymentMethod } : {}),
    ...(maxPrice && parseUsd(maxPrice) !== undefined ? { maxPrice } : {}),
    sort: sort && (catalogSorts as readonly string[]).includes(sort) ? sort as CatalogSort : defaultSort,
    ...(cursor && /^\d{1,6}$/.test(cursor) ? { cursor } : {}),
  };
};

/** The query as URL parameters, without its defaults, for links and for GET /v1/catalog. */
export const catalogQueryParams = (query: CatalogQuery, changes: Partial<Record<keyof CatalogQuery, string | undefined>> = {}): URLSearchParams => {
  const merged: Record<string, string | number | undefined> = { ...query, ...changes };
  const params = new URLSearchParams();
  for (const key of ['category', 'q', 'method', 'maxPrice', 'sort', 'limit', 'cursor'] as const) {
    const value = merged[key];
    if (value === undefined || value === '' || (key === 'sort' && value === defaultSort))
      continue;
    params.set(key, String(value));
  }

  return params;
};

/** A category, or one of its subcategories. */
export const inCategory = (category: string, filter: string): boolean => category === filter || category.startsWith(`${filter}/`);

const words = (text: string): readonly string[] => text.toLowerCase().split(/\s+/).filter(word => word !== '');

const matchesText = (item: CatalogItem, q: string): boolean => {
  const haystack = [item.id, item.title, item.summary, item.category, ...item.tags].join(' ').toLowerCase();

  return words(q).every(word => haystack.includes(word));
};

/** Every filter of the query but the category: what the category counts are taken over. */
const matchesFilters = (item: CatalogItem, query: CatalogQuery): boolean => {
  const max = query.maxPrice === undefined ? undefined : parseUsd(query.maxPrice);

  return (query.q === undefined || matchesText(item, query.q))
    && (query.method === undefined || item.methods.includes(query.method))
    && (max === undefined || (parseUsd(item.priceFrom) ?? 0n) <= max);
};

const byId = (left: CatalogItem, right: CatalogItem): number => left.id.localeCompare(right.id);

const sorters: Readonly<Record<CatalogSort, (left: CatalogItem, right: CatalogItem) => number>> = {
  popular: (left, right) => right.stats.calls30d - left.stats.calls30d || byId(left, right),
  price: (left, right) => {
    const difference = (parseUsd(left.priceFrom) ?? 0n) - (parseUsd(right.priceFrom) ?? 0n);

    return difference === 0n ? right.stats.calls30d - left.stats.calls30d || byId(left, right) : difference < 0n ? -1 : 1;
  },
  newest: (left, right) => right.updatedAt.localeCompare(left.updatedAt) || byId(left, right),
  success: (left, right) => right.stats.successRate - left.stats.successRate || right.stats.calls30d - left.stats.calls30d || byId(left, right),
};

/**
 * CI-5 over a list of services, as GET /v1/catalog answers it: filtered by category (subcategories
 * included), text, payment method, and maximum price, sorted, and paged. Category counts cover every
 * filter but the category, so the page shows where else the same search finds services.
 */
export const queryCatalog = (
  items: readonly CatalogItem[],
  categoryTitles: ReadonlyMap<string, string>,
  query: CatalogQuery,
): { readonly services: readonly CatalogItem[]; readonly categories: readonly CatalogCategory[]; readonly next: string | null } => {
  const filtered = items.filter(item => matchesFilters(item, query));
  const matching = filtered.filter(item => query.category === undefined || inCategory(item.category, query.category));
  const sorted = [...matching].sort(sorters[query.sort]);
  const offset = Number(query.cursor ?? 0);
  const limit = query.limit ?? defaultPageSize;
  const page = sorted.slice(offset, offset + limit);

  const categories = [...categoryTitles]
    .map(([id, title]) => ({ id, title, count: filtered.filter(item => inCategory(item.category, id)).length }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return { services: page, categories, next: offset + limit < sorted.length ? String(offset + limit) : null };
};
