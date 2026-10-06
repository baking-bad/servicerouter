import { and, asc, eq } from 'drizzle-orm';

import type { SealedSecret, ServiceSecretRepository, StoredSecret } from '@servicerouter/core';

import type { DatabaseExecutor } from './postgres.js';
import { serviceSecrets } from './schema/secrets.js';

export interface ServiceSecretRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
}

const infoColumns = {
  name: serviceSecrets.name,
  origin: serviceSecrets.origin,
  updatedAt: serviceSecrets.updatedAt,
};

const toStoredSecret = (row: typeof serviceSecrets.$inferSelect): StoredSecret => ({
  name: row.name,
  origin: row.origin,
  updatedAt: row.updatedAt,
  sealed: Object.freeze<SealedSecret>({
    version: row.version as SealedSecret['version'],
    keyId: row.keyId,
    // Each one a copy in memory of its own (the bytea column, backlog D-3)
    wrappedKey: row.wrappedKey,
    iv: row.iv,
    ciphertext: row.ciphertext,
    tag: row.tag,
  }),
});

/** The `service_secrets` table (Secrets, SC-2). Rows hold sealed values only, with the origin each is bound to (SC-10). */
export const createServiceSecretRepository = ({ db }: ServiceSecretRepositoryOptions): ServiceSecretRepository => ({
  list: async serviceId => db.select(infoColumns).from(serviceSecrets)
    .where(eq(serviceSecrets.serviceId, serviceId))
    .orderBy(asc(serviceSecrets.name)),
  listSealed: async serviceId => {
    const rows = await db.select().from(serviceSecrets)
      .where(eq(serviceSecrets.serviceId, serviceId))
      .orderBy(asc(serviceSecrets.name));

    return rows.map(toStoredSecret);
  },
  put: async ({ serviceId, name, origin, sealed, updatedAt }) => {
    const values = {
      version: sealed.version,
      keyId: sealed.keyId,
      wrappedKey: sealed.wrappedKey,
      iv: sealed.iv,
      ciphertext: sealed.ciphertext,
      tag: sealed.tag,
      origin,
      updatedAt,
    };
    await db.insert(serviceSecrets)
      .values({ serviceId, name, ...values })
      .onConflictDoUpdate({ target: [serviceSecrets.serviceId, serviceSecrets.name], set: values });
  },
  delete: async (serviceId, name) => {
    const deleted = await db.delete(serviceSecrets)
      .where(and(eq(serviceSecrets.serviceId, serviceId), eq(serviceSecrets.name, name)))
      .returning({ name: serviceSecrets.name });

    return deleted.length > 0;
  },
});
