import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';

import type { Clock, IdGenerator, ServiceId } from '@servicerouter/common';
import {
  cryptoRandomSource, findMovedSecrets, generateVerificationToken, nextHostState, ownershipRecheckIntervalMs, serviceStateFor,
  type AuditEntry, type HostStatus, type OwnershipActor, type OwnershipStatus, type OwnershipStore, type PayoutConfirmation,
  type RandomSource, type ServiceStateChange,
} from '@servicerouter/core';

import { createAuditLogRepository } from './auditLogRepository.js';
import { withTransaction, type DatabaseExecutor } from './postgres.js';
import { payoutConfirmations, upstreamHosts, verificationTokens } from './schema/ownership.js';
import { services } from './schema/services.js';
import { createServiceRepository } from './serviceRepository.js';
import { createServiceSecretRepository } from './serviceSecretRepository.js';

export interface OwnershipRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
}

export interface OwnershipStoreOptions extends OwnershipRepositoryOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  // Randomness for verification tokens. Default: node:crypto.
  readonly random?: RandomSource;
}

/** The `payout_confirmations` table (OV-10), for the registry's submit and rollback, inside their transaction. */
export interface PayoutConfirmationRepository {
  find(serviceId: string): Promise<PayoutConfirmation | undefined>;
  /** Inserts or replaces the service's waiting payout change. */
  put(confirmation: Omit<PayoutConfirmation, 'confirmedHosts'> & { readonly nextCheckAt: Date }): Promise<void>;
  /** Drops the service's waiting payout change. Returns it, if there was one. */
  delete(serviceId: string): Promise<PayoutConfirmation | undefined>;
}

const toConfirmation = (row: typeof payoutConfirmations.$inferSelect): PayoutConfirmation => ({
  serviceId: row.serviceId as ServiceId,
  revision: row.revision,
  token: row.token,
  payouts: row.payouts,
  hosts: row.hosts,
  confirmedHosts: row.confirmedHosts,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
});

const toHostStatus = (row: typeof upstreamHosts.$inferSelect): HostStatus => ({
  host: row.host,
  state: row.state,
  checkedAt: row.checkedAt ?? undefined,
  problem: row.problem ?? undefined,
  missingSince: row.missingSince ?? undefined,
});

export const createPayoutConfirmationRepository = ({ db }: OwnershipRepositoryOptions): PayoutConfirmationRepository => ({
  find: async serviceId => {
    const [row] = await db.select().from(payoutConfirmations).where(eq(payoutConfirmations.serviceId, serviceId));

    return row ? toConfirmation(row) : undefined;
  },
  put: async ({ serviceId, revision, token, payouts, hosts, createdAt, expiresAt, nextCheckAt }) => {
    const values = { revision, token, payouts, hosts: [...hosts], confirmedHosts: [], createdAt, expiresAt, nextCheckAt };
    await db.insert(payoutConfirmations)
      .values({ serviceId, ...values })
      .onConflictDoUpdate({ target: payoutConfirmations.serviceId, set: values });
  },
  delete: async serviceId => {
    const [row] = await db.delete(payoutConfirmations).where(eq(payoutConfirmations.serviceId, serviceId)).returning();

    return row ? toConfirmation(row) : undefined;
  },
});

const hostStatusesOn = async (db: DatabaseExecutor, accountId: string, hosts: readonly string[]): Promise<ReadonlyMap<string, HostStatus>> => {
  if (hosts.length === 0)
    return new Map();

  const rows = await db.select().from(upstreamHosts).where(and(eq(upstreamHosts.accountId, accountId), inArray(upstreamHosts.host, [...hosts])));

  return new Map(rows.map(row => [row.host, toHostStatus(row)]));
};

/** The `upstream_hosts` adapter of the registry's `OwnershipStatus` port (SR-8). */
export const createOwnershipStatus = ({ db }: OwnershipRepositoryOptions): OwnershipStatus => ({
  hostStates: async ({ accountId, hosts }) =>
    new Map([...await hostStatusesOn(db, accountId, hosts)].map(([host, status]) => [host, status.state])),
});

/**
 * Ownership verification's storage (OV-1 to OV-10): `verification_tokens`, `upstream_hosts`, and
 * `payout_confirmations`. A host check locks the host's row, then the services that use it, so a
 * check and the services' states change together. Service rows change through the Service registry's
 * repository (rule 3).
 */
export const createOwnershipStore = ({ db, clock, ids, random = cryptoRandomSource }: OwnershipStoreOptions): OwnershipStore => {
  const audit = (who: OwnershipActor, action: AuditEntry['action'], subject: AuditEntry['subject'], details: AuditEntry['details']): AuditEntry => ({
    actor: who.actor,
    action,
    subject,
    ...(who.requestId === undefined ? {} : { requestId: who.requestId }),
    ...(details === undefined ? {} : { details }),
  });

  return {
    verificationToken: async accountId => {
      const [existing] = await db.select({ token: verificationTokens.token }).from(verificationTokens).where(eq(verificationTokens.accountId, accountId));
      if (existing)
        return existing.token;

      await db.insert(verificationTokens)
        .values({ accountId, token: generateVerificationToken(random), createdAt: clock.now() })
        .onConflictDoNothing({ target: verificationTokens.accountId });
      // Another request may have created it first: its token wins
      const [row] = await db.select({ token: verificationTokens.token }).from(verificationTokens).where(eq(verificationTokens.accountId, accountId));

      return row!.token;
    },

    hostStatuses: (accountId, hosts) => hostStatusesOn(db, accountId, hosts),

    findService: async serviceId => {
      const service = await createServiceRepository({ db }).find(serviceId);

      return service?.activeRevision === undefined
        ? undefined
        : { id: service.id, ownerAccountId: service.ownerAccountId, state: service.state, activeRevision: service.activeRevision, hosts: service.hosts };
    },

    findConfirmation: serviceId => createPayoutConfirmationRepository({ db }).find(serviceId),

    recordHostCheck: ({ accountId, host, found, problem, now, ...who }) => withTransaction(db, async tx => {
      await tx.insert(upstreamHosts)
        .values({ accountId, host, state: 'unverified', nextCheckAt: now, updatedAt: now })
        .onConflictDoNothing();
      const [row] = await tx.select().from(upstreamHosts)
        .where(and(eq(upstreamHosts.accountId, accountId), eq(upstreamHosts.host, host)))
        .for('update');
      const from = row!.state;
      const outcome = nextHostState({ state: from, missingSince: row!.missingSince ?? undefined }, found, now);
      await tx.update(upstreamHosts).set({
        state: outcome.state,
        missingSince: outcome.missingSince ?? null,
        checkedAt: now,
        problem: found ? null : problem ?? 'token_missing',
        nextCheckAt: outcome.nextCheckAt,
        updatedAt: now,
      }).where(and(eq(upstreamHosts.accountId, accountId), eq(upstreamHosts.host, host)));

      const log = createAuditLogRepository({ db: tx, clock, ids });
      if (outcome.state !== from)
        await log.append(audit(who, 'ownership.host_state', { kind: 'upstream_host', id: host }, { accountId, from, to: outcome.state, problem: found ? null : problem ?? null }));

      // Every service that uses the host follows it, even when the host's state is unchanged, so a
      // state an activation computed from an older reading is put right (OV-5)
      const repository = createServiceRepository({ db: tx });
      const serviceChanges: ServiceStateChange[] = [];
      for (const service of await repository.lockUsingHost(accountId, host)) {
        const states = await hostStatusesOn(tx, accountId, service.hosts);
        const state = serviceStateFor(service.hosts.map(serviceHost => states.get(serviceHost)?.state));
        if (state === service.state)
          continue;

        await repository.setState({ id: service.id, state, updatedAt: now });
        await log.append(audit(who, 'service.state', { kind: 'service', id: service.id }, { from: service.state, to: state, host }));
        serviceChanges.push({ serviceId: service.id, from: service.state, to: state });
      }

      return {
        hostChange: outcome.state === from ? undefined : { accountId, host, from, to: outcome.state, missingSince: outcome.missingSince },
        serviceChanges,
      };
    }),

    recordConfirmationCheck: ({ serviceId, token, confirmedHosts, now, ...who }) => withTransaction(db, async tx => {
      const repository = createServiceRepository({ db: tx });
      const confirmations = createPayoutConfirmationRepository({ db: tx });
      const service = await repository.lock(serviceId);
      const confirmation = service && await confirmations.find(serviceId);
      if (!service || !confirmation || confirmation.token !== token)
        return { kind: 'none' } as const;

      const log = createAuditLogRepository({ db: tx, clock, ids });
      const subject = { kind: 'service', id: serviceId };
      if (confirmation.expiresAt <= now) {
        await confirmations.delete(serviceId);
        await log.append(audit(who, 'service.payout_change_expire', subject, { revision: confirmation.revision }));

        return { kind: 'expired', revision: confirmation.revision } as const;
      }

      const confirmed = confirmation.hosts.filter(host => confirmedHosts.includes(host));
      if (confirmed.length === confirmation.hosts.length) {
        const revision = (await repository.findRevision(serviceId, confirmation.revision))!;
        // The stored secrets must still be sealed for the waiting revision's hosts (SC-10)
        const stored = await createServiceSecretRepository({ db: tx }).list(serviceId);
        const moved = findMovedSecrets(revision.config, new Map(stored.map(secret => [secret.name, secret.origin])));
        if (moved.length === 0) {
          const states = await hostStatusesOn(tx, service.ownerAccountId, confirmation.hosts);
          const state = serviceStateFor(confirmation.hosts.map(host => states.get(host)?.state));
          await repository.activate({ id: serviceId, revision: confirmation.revision, hosts: confirmation.hosts, state, updatedAt: now });
          await confirmations.delete(serviceId);
          await log.append(audit(who, 'service.payout_change_confirm', subject, { revision: confirmation.revision }));
          await log.append(audit(who, 'service.activate', subject, {
            revision: confirmation.revision, previousRevision: service.activeRevision ?? null, state, payoutsChanged: true,
          }));

          return { kind: 'activated', revision: confirmation.revision, state } as const;
        }
      }

      const nextCheckAt = new Date(now.getTime() + ownershipRecheckIntervalMs);
      await tx.update(payoutConfirmations).set({ confirmedHosts: confirmed, nextCheckAt }).where(eq(payoutConfirmations.serviceId, serviceId));

      return { kind: 'waiting', confirmation: { ...confirmation, confirmedHosts: confirmed } } as const;
    }),

    expireConfirmations: ({ now, ...who }) => withTransaction(db, async tx => {
      const expired = await tx.delete(payoutConfirmations).where(lte(payoutConfirmations.expiresAt, now)).returning();
      const log = createAuditLogRepository({ db: tx, clock, ids });
      for (const row of expired)
        await log.append(audit(who, 'service.payout_change_expire', { kind: 'service', id: row.serviceId }, { revision: row.revision }));

      return expired.map(row => ({ serviceId: row.serviceId as ServiceId, revision: row.revision }));
    }),

    dueHosts: async ({ now, limit }) => db.select({ accountId: upstreamHosts.accountId, host: upstreamHosts.host })
      .from(upstreamHosts)
      .where(and(
        lte(upstreamHosts.nextCheckAt, now),
        sql`exists (select 1 from ${services} where ${services.ownerAccountId} = ${upstreamHosts.accountId}
          and ${services.state} in ('live', 'suspended') and ${upstreamHosts.host} = any(${services.hosts}))`,
      ))
      .orderBy(asc(upstreamHosts.nextCheckAt))
      .limit(limit),

    dueConfirmations: async ({ now, limit }) => (await db.select({ serviceId: payoutConfirmations.serviceId })
      .from(payoutConfirmations)
      .where(and(lte(payoutConfirmations.nextCheckAt, now), gt(payoutConfirmations.expiresAt, now)))
      .orderBy(asc(payoutConfirmations.nextCheckAt))
      .limit(limit)).map(row => row.serviceId as ServiceId),
  };
};
