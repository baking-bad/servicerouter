import { and, eq } from 'drizzle-orm';

import type { ServiceDocumentKind, ServiceDocuments } from '@servicerouter/core';

import type { DatabaseExecutor } from './postgres.js';
import { serviceDocuments } from './schema/serviceDocuments.js';

export interface StoredServiceDocument {
  readonly content: string;
  readonly etag: string;
  readonly inputsHash: string;
}

/** The `service_documents` table (Agent docs, AD-4). */
export interface ServiceDocumentRepository {
  find(serviceId: string, revision: number, kind: ServiceDocumentKind): Promise<StoredServiceDocument | undefined>;
  /** Stores a revision's whole set, replacing what was there. */
  put(input: { readonly serviceId: string; readonly revision: number; readonly inputsHash: string; readonly documents: ServiceDocuments; readonly now: Date }): Promise<void>;
}

export const createServiceDocumentRepository = ({ db }: { readonly db: DatabaseExecutor }): ServiceDocumentRepository => ({
  find: async (serviceId, revision, kind) => {
    const [row] = await db.select({ content: serviceDocuments.content, etag: serviceDocuments.etag, inputsHash: serviceDocuments.inputsHash })
      .from(serviceDocuments)
      .where(and(eq(serviceDocuments.serviceId, serviceId), eq(serviceDocuments.revision, revision), eq(serviceDocuments.kind, kind)));

    return row;
  },
  put: async ({ serviceId, revision, inputsHash, documents, now }) => {
    const rows = Object.entries(documents).map(([kind, document]) => ({
      serviceId, revision, kind: kind as ServiceDocumentKind, content: document.content, etag: document.etag, inputsHash, createdAt: now,
    }));
    for (const row of rows) {
      await db.insert(serviceDocuments).values(row).onConflictDoUpdate({
        target: [serviceDocuments.serviceId, serviceDocuments.revision, serviceDocuments.kind],
        set: { content: row.content, etag: row.etag, inputsHash: row.inputsHash, createdAt: row.createdAt },
      });
    }
  },
});
