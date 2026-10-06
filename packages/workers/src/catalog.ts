import type { Clock, Logger, ServiceId } from '@servicerouter/common';
import { buildCatalogEntry, compileServiceRuntime, type CatalogEntry, type PlatformConfig } from '@servicerouter/core';
import type { CatalogRepository, Database } from '@servicerouter/db';
import { createServiceRepository } from '@servicerouter/db';

// WK-1: one runner across replicas
export const catalogIndexLockId = 7_301_746_208;
export const serviceStatsLockId = 7_301_746_209;
// CI-1: activations, suspensions, and price changes reach the catalog within a minute
export const catalogIndexIntervalMs = 60_000;
// CI-4: every few minutes
export const serviceStatsIntervalMs = 5 * 60_000;
export const catalogIndexJobName = 'catalog_index';
export const serviceStatsJobName = 'service_stats';
const statsWindowMs = 30 * 24 * 60 * 60 * 1_000;

/**
 * The catalog index (CI-1): every live registered service, from its active revision, compiled with the
 * current platform config. Anything else leaves the catalog: suspended and pending services, and
 * those gone. A service that doesn't compile is logged and left out.
 */
export const createCatalogIndex = ({ db, catalog, config, logger }: {
  readonly db: Database;
  readonly catalog: Pick<CatalogRepository, 'syncEntries'>;
  readonly config: PlatformConfig;
  readonly logger: Logger;
}) => async (): Promise<number> => {
  const services = createServiceRepository({ db });
  const entries: CatalogEntry[] = [];
  for (const id of await services.idsInState('live')) {
    const serving = await services.loadForServing(id);
    if (!serving || serving.state !== 'live')
      continue;
    const compiled = compileServiceRuntime({
      serviceId: id as ServiceId, revision: serving.revision, state: serving.state, config: serving.config, openapiDocuments: serving.openapiDocuments, platform: config,
    });
    if (!compiled.ok) {
      logger.error({ serviceId: id }, 'A live service doesn\'t compile: it stays out of the catalog');
      continue;
    }
    entries.push(buildCatalogEntry({ serviceId: id, config: serving.config, runtime: compiled.runtime, platform: config }));
  }
  await catalog.syncEntries(entries);

  return entries.length;
};

/** Service stats (CI-4): the last 30 days of payments, per service and route. */
export const createServiceStats = ({ catalog, clock }: { readonly catalog: Pick<CatalogRepository, 'computeStats'>; readonly clock: Clock }) =>
  async (): Promise<number> => catalog.computeStats(new Date(clock.now().getTime() - statsWindowMs));
