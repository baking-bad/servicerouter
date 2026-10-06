import { isMocked, type SiteSettings } from '../config';
import { catalogQueryParams, queryCatalog } from '../catalog/query';
import { sampleCategoryTitles, sampleServices, toCatalogItem, type SampleLinks } from '../mocks/catalog';
import { ApiError, callApi } from './http';
import type { CatalogPage, CatalogQuery, CatalogService, Sourced } from './types';

// The catalog (CI-5): GET /v1/catalog and GET /v1/catalog/{id}, or sample data until step 13 (WB-10).

/**
 * A service's agent documents: served by the website from the catalog while `agent-docs` is sample
 * data, otherwise the Platform API's (AR1).
 */
export const agentDocsFor = (settings: SiteSettings, id: string): CatalogService['docs'] => isMocked(settings, 'agent-docs')
  ? { openapi: `${settings.siteUrl}/discover/${id}/openapi.json`, llms: `${settings.siteUrl}/discover/${id}/llms.txt`, skill: `${settings.siteUrl}/discover/${id}/skill.md` }
  : { openapi: `${settings.apiUrl}/v1/services/${id}/openapi.json`, llms: `${settings.apiUrl}/v1/services/${id}/llms.txt`, skill: `${settings.apiUrl}/v1/services/${id}/skill.md` };

const sampleLinks = (settings: SiteSettings): SampleLinks => ({
  docsFor: id => agentDocsFor(settings, id),
  payUrlFor: id => `${settings.payUrl}/service/${id}`,
});

/** `GET /v1/catalog`: services matching the query, a page at a time, with category counts. */
export const listCatalog = async (settings: SiteSettings, query: CatalogQuery): Promise<Sourced<CatalogPage>> => {
  if (isMocked(settings, 'catalog'))
    return { value: queryCatalog(sampleServices(sampleLinks(settings)).map(toCatalogItem), sampleCategoryTitles, query), sample: true };

  const params = catalogQueryParams(query).toString();

  return { value: await callApi<CatalogPage>(settings.apiUrl, { path: `/v1/catalog${params ? `?${params}` : ''}` }), sample: false };
};

/** `GET /v1/catalog/{id}`, or undefined for a service the catalog doesn't list. */
export const getCatalogService = async (settings: SiteSettings, id: string): Promise<Sourced<CatalogService> | undefined> => {
  if (isMocked(settings, 'catalog')) {
    const found = sampleServices(sampleLinks(settings)).find(service => service.id === id);

    return found ? { value: found, sample: true } : undefined;
  }

  try {
    const service = await callApi<CatalogService>(settings.apiUrl, { path: `/v1/catalog/${encodeURIComponent(id)}` });

    return { value: { ...service, docs: agentDocsFor(settings, service.id) }, sample: false };
  }
  catch (error) {
    if (error instanceof ApiError && error.status === 404)
      return undefined;
    throw error;
  }
};

/** Every listed service, following the pages, for the sitemap and llms-full.txt. */
export const listAllCatalog = async (settings: SiteSettings): Promise<Sourced<CatalogPage>> => {
  const first = await listCatalog(settings, { sort: 'popular', limit: 100 });
  const services = [...first.value.services];
  let next = first.value.next;
  // A bound, so a catalog that keeps paging can't hold a request forever
  for (let pages = 1; next !== null && pages < 50; pages += 1) {
    const page = await listCatalog(settings, { sort: 'popular', limit: 100, cursor: next });
    services.push(...page.value.services);
    next = page.value.next;
  }

  return { value: { services, categories: first.value.categories, next: null }, sample: first.sample };
};
