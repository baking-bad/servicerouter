import { and, arrayContains, asc, desc, eq, max } from 'drizzle-orm';

import type { ServiceId } from '@servicerouter/common';
import type { ServiceRecord, ServiceRepository, ServiceRevision } from '@servicerouter/core';

import { withSnapshot, type DatabaseExecutor } from './postgres.js';
import { serviceRevisions, services } from './schema/services.js';
import { createServiceSecretRepository } from './serviceSecretRepository.js';

export interface ServiceRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
}

const toRecord = (row: typeof services.$inferSelect): ServiceRecord => ({
  id: row.id as ServiceId,
  ownerAccountId: row.ownerAccountId,
  state: row.state,
  activeRevision: row.activeRevision ?? undefined,
  hosts: row.hosts,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toRevision = (row: typeof serviceRevisions.$inferSelect): ServiceRevision => ({
  serviceId: row.serviceId as ServiceId,
  number: row.number,
  submitted: { mediaType: row.configMediaType, text: row.configText },
  config: row.config,
  openapiDocuments: new Map(Object.entries(row.openapiDocuments)),
  createdBy: row.createdBy,
  createdAt: row.createdAt,
});

const byRevision = (id: string, number: number) => and(eq(serviceRevisions.serviceId, id), eq(serviceRevisions.number, number));

/**
 * The `services` and `service_revisions` tables (Service registry). Revisions are immutable (SR-4):
 * there is no update or delete for them.
 */
export const createServiceRepository = ({ db }: ServiceRepositoryOptions): ServiceRepository => {
  const findRevision = async (id: string, number: number): Promise<ServiceRevision | undefined> => {
    const [row] = await db.select().from(serviceRevisions).where(byRevision(id, number));

    return row ? toRevision(row) : undefined;
  };

  return {
    find: async id => {
      const [row] = await db.select().from(services).where(eq(services.id, id));

      return row ? toRecord(row) : undefined;
    },
    lock: async id => {
      const [row] = await db.select().from(services).where(eq(services.id, id)).for('update');

      return row ? toRecord(row) : undefined;
    },
    createIfMissing: async ({ id, ownerAccountId, state, createdAt }) => {
      const created = await db.insert(services)
        .values({ id, ownerAccountId, state, createdAt, updatedAt: createdAt })
        .onConflictDoNothing({ target: services.id })
        .returning({ id: services.id });

      return created.length > 0;
    },
    activate: async ({ id, revision, hosts, state, updatedAt }) => {
      await db.update(services).set({ activeRevision: revision, hosts: [...hosts], state, updatedAt }).where(eq(services.id, id));
    },
    setState: async ({ id, state, updatedAt }) => {
      await db.update(services).set({ state, updatedAt }).where(eq(services.id, id));
    },
    // In ID order, so two checks lock the same services in the same order
    lockUsingHost: async (accountId, host) => (await db.select().from(services)
      .where(and(eq(services.ownerAccountId, accountId), arrayContains(services.hosts, [host])))
      .orderBy(asc(services.id))
      .for('update')).map(toRecord),
    insertRevision: async revision => {
      await db.insert(serviceRevisions).values({
        serviceId: revision.serviceId,
        number: revision.number,
        configText: revision.submitted.text,
        configMediaType: revision.submitted.mediaType,
        config: revision.config,
        openapiDocuments: Object.fromEntries(revision.openapiDocuments),
        createdBy: revision.createdBy,
        createdAt: revision.createdAt,
      });
    },
    findRevision,
    listRevisions: async id => db.select({
      number: serviceRevisions.number,
      mediaType: serviceRevisions.configMediaType,
      createdBy: serviceRevisions.createdBy,
      createdAt: serviceRevisions.createdAt,
    }).from(serviceRevisions)
      .where(eq(serviceRevisions.serviceId, id))
      .orderBy(desc(serviceRevisions.number)),
    latestRevisionNumber: async id => {
      const [row] = await db.select({ latest: max(serviceRevisions.number) }).from(serviceRevisions).where(eq(serviceRevisions.serviceId, id));

      return row?.latest ?? 0;
    },
    loadForServing: id => withSnapshot(db, async tx => {
      const [row] = await tx.select({ service: services, revision: serviceRevisions })
        .from(services)
        .innerJoin(serviceRevisions, and(eq(serviceRevisions.serviceId, services.id), eq(serviceRevisions.number, services.activeRevision)))
        .where(eq(services.id, id));
      if (!row)
        return undefined;

      const revision = toRevision(row.revision);

      return {
        serviceId: revision.serviceId,
        ownerAccountId: row.service.ownerAccountId,
        state: row.service.state,
        revision: revision.number,
        config: revision.config,
        openapiDocuments: revision.openapiDocuments,
        secrets: await createServiceSecretRepository({ db: tx }).listSealed(id),
      };
    }),
  };
};
