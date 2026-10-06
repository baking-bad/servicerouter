import type { Logger, Secret } from '@servicerouter/common';
import {
  compileServiceRuntime, type PlatformConfig, type SecretOpener, type ServiceRepository, type ServiceRuntime,
} from '@servicerouter/core';

import type { CacheLoad } from './cache.js';

/** A service ready to serve: its compiled runtime, and its secrets opened, by secret name (SC-5). */
export interface LoadedService {
  readonly runtime: ServiceRuntime;
  readonly secrets: ReadonlyMap<string, Secret>;
}

/** Whether the service can serve. `unavailable` answers 503: it exists, but can't be served safely. */
export type ServiceLoad = LoadedService | 'unavailable';

export interface ServiceLoaderOptions {
  readonly services: Pick<ServiceRepository, 'loadForServing'>;
  readonly opener: SecretOpener;
  readonly platform: PlatformConfig;
  readonly logger: Logger;
}

/** Destroys a loaded service's secrets, when it leaves the cache (SC-5). */
export const disposeService = (load: ServiceLoad): void => {
  if (load === 'unavailable')
    return;

  for (const secret of load.secrets.values())
    secret.destroy();
};

/**
 * Loads a service for the runtime cache (PX-3, SC-5): its active revision in one snapshot, compiled,
 * with every secret its credentials use opened. Each secret opens with the origin of the runtime
 * upstream that sends it, never the origin stored on its row (SC-10). A secret that is missing or
 * doesn't open makes the whole service unavailable: the proxy never forwards without the seller's
 * credential. A service that isn't live opens nothing, since it serves nothing.
 */
export const createServiceLoader = ({ services, opener, platform, logger }: ServiceLoaderOptions) =>
  async (serviceId: string): Promise<CacheLoad<ServiceLoad>> => {
    const serving = await services.loadForServing(serviceId);
    if (!serving)
      return { kind: 'none' };

    const compiled = compileServiceRuntime({
      serviceId: serving.serviceId,
      revision: serving.revision,
      state: serving.state,
      config: serving.config,
      openapiDocuments: serving.openapiDocuments,
      platform,
    });
    if (!compiled.ok) {
      logger.error({ serviceId, revision: serving.revision, problems: compiled.errors.length }, 'The active revision doesn\'t compile');
      return { kind: 'value', value: 'unavailable' };
    }

    const { runtime } = compiled;
    if (runtime.state !== 'live')
      return { kind: 'value', value: { runtime, secrets: new Map() } };

    // The origin each secret goes to, from the compiled runtime
    const origins = new Map<string, string>();
    for (const { upstream, credentials } of runtime.operations) {
      for (const { secretName } of credentials) {
        const origin = origins.get(secretName);
        if (origin !== undefined && origin !== upstream.origin) {
          logger.error({ serviceId, revision: runtime.revision, secretName }, 'A secret is sent to two origins');
          return { kind: 'value', value: 'unavailable' };
        }
        origins.set(secretName, upstream.origin);
      }
    }

    const stored = new Map(serving.secrets.map(secret => [secret.name, secret]));
    const opened = new Map<string, Secret>();
    const fail = (secretName: string, message: string): CacheLoad<ServiceLoad> => {
      for (const secret of opened.values())
        secret.destroy();
      logger.warn({ serviceId, revision: runtime.revision, secretName }, message);

      return { kind: 'value', value: 'unavailable' };
    };
    for (const [secretName, origin] of origins) {
      const row = stored.get(secretName);
      if (!row)
        return fail(secretName, 'A secret the service needs is not set');
      try {
        opened.set(secretName, opener.open({ serviceId: runtime.serviceId, name: secretName, origin, sealed: row.sealed }));
      }
      catch {
        // secret_open_failed says nothing more: tampering, another origin, or an unknown key
        return fail(secretName, 'A secret the service needs doesn\'t open');
      }
    }

    return { kind: 'value', value: { runtime, secrets: opened } };
  };
