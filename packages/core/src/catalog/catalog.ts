import type { MicroUsd } from '@servicerouter/common';

import { paymentMethodsFor, type PaymentMethod } from '../agentDocs/generate.js';
import type { PlatformConfig } from '../platform/config.js';
import type { ServiceConfigDocument } from '../service/document.js';
import type { ServiceRuntime } from '../service/runtime.js';

/** A route of a catalog entry (CI-1, CI-5). */
export interface CatalogRouteEntry {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly price: MicroUsd;
  readonly methods: readonly PaymentMethod[];
}

/** What the catalog indexes of a live registered service (CI-1). */
export interface CatalogEntry {
  readonly serviceId: string;
  readonly revision: number;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly links: { readonly homepage?: string; readonly docs?: string };
  readonly contact: { readonly name?: string; readonly url?: string; readonly email?: string };
  // The cheapest enabled route's price
  readonly priceFrom: MicroUsd;
  // Every method some route takes
  readonly methods: readonly PaymentMethod[];
  readonly routes: readonly CatalogRouteEntry[];
}

/** The catalog's view of a service from its active revision and compiled runtime (CI-1). Deterministic. */
export const buildCatalogEntry = ({ serviceId, config, runtime, platform }: {
  readonly serviceId: string;
  readonly config: ServiceConfigDocument;
  readonly runtime: ServiceRuntime;
  readonly platform: PlatformConfig;
}): CatalogEntry => {
  const routes = runtime.operations.filter(operation => operation.enabled).map(operation => ({
    key: operation.routeKey ?? `${operation.method.toUpperCase()} ${operation.path}`,
    method: operation.method.toUpperCase(),
    path: operation.path,
    summary: operation.docs.summary ?? operation.docs.description ?? '',
    price: operation.price,
    methods: paymentMethodsFor(operation.price, platform),
  }));
  const methods = (['credits', 'x402', 'mpp'] as const).filter(method => routes.some(route => route.methods.includes(method)));
  const { service } = config;

  return {
    serviceId,
    revision: runtime.revision,
    title: service.title,
    summary: service.summary ?? service.description.split('\n')[0]!.trim(),
    description: service.description.trim(),
    category: service.category,
    tags: [...service.tags ?? []],
    links: { ...service.links?.homepage ? { homepage: service.links.homepage } : {}, ...service.links?.docs ? { docs: service.links.docs } : {} },
    contact: {
      ...service.contact?.name ? { name: service.contact.name } : {},
      ...service.contact?.url ? { url: service.contact.url } : {},
      ...service.contact?.email ? { email: service.contact.email } : {},
    },
    priceFrom: routes.reduce<MicroUsd | undefined>((lowest, route) => lowest === undefined || route.price < lowest ? route.price : lowest, undefined) ?? (0n as MicroUsd),
    methods,
    routes,
  };
};

/** Whether a category matches a filter: the same ID, or one of its subcategories (CI-3, CI-5). */
export const inCategory = (category: string, filter: string): boolean => category === filter || category.startsWith(`${filter}/`);

export const catalogSorts = ['popular', 'price', 'newest', 'success'] as const;
export type CatalogSort = typeof catalogSorts[number];
