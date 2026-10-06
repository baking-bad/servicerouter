import type { Clock, ServiceId } from '@servicerouter/common';
import {
  compileServiceRuntime, generateServiceDocuments, serviceDocumentsInputHash, type PlatformConfig, type ServiceDocumentKind,
} from '@servicerouter/core';
import { createServiceDocumentRepository, createServiceRepository, type Database, type StoredServiceDocument } from '@servicerouter/db';

import { NotFoundError } from '../errors.js';

/** The documents agents read (AR1). `bazaar.json` is stored for PR-7, not served. */
export const servedDocumentKinds = ['openapi.json', 'llms.txt', 'skill.md'] as const satisfies readonly ServiceDocumentKind[];
export type ServedDocumentKind = typeof servedDocumentKinds[number];

export interface AgentDocsService {
  /**
   * A live service's document for its active revision (AD-4). Made and stored the first time it is
   * asked for after an activation, or after anything it is made from changed. Others are `404`.
   */
  find(serviceId: string, kind: ServedDocumentKind): Promise<StoredServiceDocument>;
}

const notFound = (): NotFoundError => new NotFoundError('No such service');

export const createAgentDocsService = ({ db, config, clock }: { readonly db: Database; readonly config: PlatformConfig; readonly clock: Clock }): AgentDocsService => {
  const services = createServiceRepository({ db });
  const documents = createServiceDocumentRepository({ db });

  return {
    find: async (serviceId, kind) => {
      const service = await services.find(serviceId);
      // Only a live service has public documents: a pending one isn't verified, a suspended one isn't served
      if (!service || service.state !== 'live' || service.activeRevision === undefined)
        throw notFound();

      const revision = (await services.findRevision(serviceId, service.activeRevision))!;
      const compiled = compileServiceRuntime({
        serviceId: serviceId as ServiceId,
        revision: revision.number,
        state: service.state,
        config: revision.config,
        openapiDocuments: revision.openapiDocuments,
        platform: config,
      });
      if (!compiled.ok)
        throw new Error(`The active revision of ${serviceId} doesn't compile`);

      const input = { config: revision.config, openapiDocuments: revision.openapiDocuments, runtime: compiled.runtime, platform: config };
      const inputsHash = serviceDocumentsInputHash(input);
      const stored = await documents.find(serviceId, revision.number, kind);
      if (stored?.inputsHash === inputsHash)
        return stored;

      const generated = generateServiceDocuments(input);
      await documents.put({ serviceId, revision: revision.number, inputsHash, documents: generated, now: clock.now() });

      return { ...generated[kind], inputsHash };
    },
  };
};
