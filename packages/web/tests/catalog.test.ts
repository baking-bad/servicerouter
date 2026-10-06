import { describe, expect, it } from 'vitest';

import { agentDocsFor, getCatalogService, listAllCatalog, listCatalog } from '../src/api/catalog';
import type { CatalogItem } from '../src/api/types';
import { catalogQueryParams, parseCatalogQuery, queryCatalog, serviceHref } from '../src/catalog/query';
import { readSettings } from '../src/config';
import { sampleCategoryTitles, sampleServices, toCatalogItem } from '../src/mocks/catalog';
import { parseUsd } from '../src/money';

const settings = readSettings({ SITE_URL: 'https://site.test', API_URL: 'https://api.test', PAY_URL: 'https://pay.test' });
const services = sampleServices({ docsFor: id => agentDocsFor(settings, id), payUrlFor: id => `${settings.payUrl}/service/${id}` });
const items = services.map(toCatalogItem);
const ids = (list: readonly CatalogItem[]) => list.map(item => item.id);
const query = (params: Record<string, string>) => queryCatalog(items, sampleCategoryTitles, parseCatalogQuery(params));

describe('the catalog query (CI-5)', () => {
  it('parses filters from the URL, leaving out values that don\'t fit', () => {
    expect(parseCatalogQuery({ category: 'finance/market-data', q: ' rates ', method: 'mpp', maxPrice: '0.005', sort: 'price', cursor: '24' }))
      .toEqual({ category: 'finance/market-data', q: 'rates', method: 'mpp', maxPrice: '0.005', sort: 'price', cursor: '24' });
    expect(parseCatalogQuery({ category: 'Finance!', method: 'card', maxPrice: 'cheap', sort: 'random', cursor: '-1' })).toEqual({ sort: 'popular' });
  });

  it('leaves out a category longer than GET /v1/catalog takes', () => {
    expect(parseCatalogQuery({ category: 'a'.repeat(64) })).toEqual({ category: 'a'.repeat(64), sort: 'popular' });
    expect(parseCatalogQuery({ category: 'a'.repeat(65) })).toEqual({ sort: 'popular' });
  });

  it('links a registered service to its page, and a routed endpoint to its routing link (CI-2, AR14)', () => {
    const routed: CatalogItem = {
      ...items[0]!, id: 'routed:api.paid.example/v1/data', category: '', verified: false, link: 'https://pay.test/api.paid.example/v1/data',
    };

    expect(serviceHref(items[0]!)).toBe(`/discover/${items[0]!.id}`);
    expect(serviceHref(routed)).toBe('https://pay.test/api.paid.example/v1/data');
  });

  it('writes a query back as URL parameters, without its defaults', () => {
    expect(catalogQueryParams({ category: 'weather', sort: 'popular' }).toString()).toBe('category=weather');
    expect(catalogQueryParams({ q: 'gpu', sort: 'price' }, { cursor: '24' }).toString()).toBe('q=gpu&sort=price&cursor=24');
  });

  it('filters by a category and its subcategories', () => {
    expect(ids(query({ category: 'finance' }).services).sort()).toEqual(['crypto-prices', 'fx-rates', 'ticker-quotes']);
    expect(ids(query({ category: 'finance/fx' }).services)).toEqual(['fx-rates']);
  });

  it('filters by text in the title, summary, tags, and category, every word matching', () => {
    expect(ids(query({ q: 'weather' }).services)).toEqual(['skycast-weather']);
    expect(ids(query({ q: 'json-rpc solana' }).services)).toEqual(['chain-rpc']);
    expect(query({ q: 'nothing-like-this' }).services).toEqual([]);
  });

  it('filters by payment method and by maximum price', () => {
    expect(query({ method: 'mpp' }).services.every(item => item.methods.includes('mpp'))).toBe(true);
    expect(query({ method: 'mpp' }).services.length).toBeLessThan(items.length);
    expect(query({ maxPrice: '0.0005' }).services.every(item => parseUsd(item.priceFrom)! <= 500n)).toBe(true);
    expect(ids(query({ maxPrice: '0.0001' }).services)).toEqual(['crypto-prices']);
  });

  it.each([
    ['popular', (left: CatalogItem, right: CatalogItem) => left.stats.calls30d >= right.stats.calls30d],
    ['price', (left: CatalogItem, right: CatalogItem) => parseUsd(left.priceFrom)! <= parseUsd(right.priceFrom)!],
    ['newest', (left: CatalogItem, right: CatalogItem) => left.updatedAt >= right.updatedAt],
    ['success', (left: CatalogItem, right: CatalogItem) => left.stats.successRate >= right.stats.successRate],
  ])('sorts by %s', (sort, inOrder) => {
    const list = query({ sort }).services;

    expect(list.slice(1).every((item, index) => inOrder(list[index]!, item))).toBe(true);
  });

  it('counts each category over every other filter, subcategories included', () => {
    const counts = Object.fromEntries(query({ category: 'weather', method: 'mpp' }).categories.map(category => [category.id, category.count]));
    const mpp = items.filter(item => item.methods.includes('mpp'));

    expect(counts['finance']).toBe(mpp.filter(item => item.category.startsWith('finance')).length);
    expect(counts['ai']).toBe(mpp.filter(item => item.category.startsWith('ai')).length);
  });

  it('pages with a cursor', () => {
    const first = queryCatalog(items, sampleCategoryTitles, { sort: 'popular', limit: 5 });
    const second = queryCatalog(items, sampleCategoryTitles, { sort: 'popular', limit: 5, cursor: first.next! });

    expect(first.services).toHaveLength(5);
    expect(first.next).toBe('5');
    expect(ids(second.services).some(id => ids(first.services).includes(id))).toBe(false);
  });
});

describe('the catalog sample data (WB-10, CI-5)', () => {
  it('has CI-5\'s shape: the cheapest route as the price from, the routes\' methods, and their calls', () => {
    for (const service of services) {
      const cheapest = service.routes.map(route => parseUsd(route.price)!).reduce((low, price) => price < low ? price : low);

      expect(parseUsd(service.priceFrom)).toBe(cheapest);
      expect([...service.methods].sort()).toEqual([...new Set(service.routes.flatMap(route => route.methods))].sort());
      expect(service.stats.calls30d).toBe(service.routes.reduce((sum, route) => sum + route.stats.calls30d, 0));
      expect(sampleCategoryTitles.has(service.category)).toBe(true);
      expect(service.payUrl).toBe(`https://pay.test/service/${service.id}`);
      expect(service.methods).toContain('credits');
    }
  });

  it('covers several categories, every payment method, and prices from $0.0001 to $0.04', () => {
    expect(new Set(items.map(item => item.category.split('/')[0])).size).toBeGreaterThanOrEqual(5);
    expect(new Set(items.flatMap(item => item.methods))).toEqual(new Set(['credits', 'x402', 'mpp']));
    const prices = services.flatMap(service => service.routes.map(route => parseUsd(route.price)!));
    expect(prices.reduce((low, price) => price < low ? price : low)).toBe(100n);
    expect(prices.reduce((high, price) => price > high ? price : high)).toBe(40_000n);
  });

  it('is labeled as sample data, and finds one service or none', async () => {
    expect((await listCatalog(settings, { sort: 'popular' })).sample).toBe(true);
    expect((await getCatalogService(settings, 'chain-rpc'))?.value.title).toBe('Chain RPC Gateway');
    expect(await getCatalogService(settings, 'no-such-service')).toBeUndefined();
    expect((await listAllCatalog(settings)).value.services).toHaveLength(services.length);
  });

  it('links agent documents on the website while they are sample data, and on the Platform API after step 10 (AR1)', () => {
    expect(agentDocsFor(settings, 'chain-rpc').openapi).toBe('https://site.test/discover/chain-rpc/openapi.json');
    expect(agentDocsFor(readSettings({ API_URL: 'https://api.test', WEB_MOCKS: 'catalog' }), 'chain-rpc'))
      .toEqual({ openapi: 'https://api.test/v1/services/chain-rpc/openapi.json', llms: 'https://api.test/v1/services/chain-rpc/llms.txt', skill: 'https://api.test/v1/services/chain-rpc/skill.md' });
  });
});
