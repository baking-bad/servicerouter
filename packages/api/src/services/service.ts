import type {
  Clock, IdGenerator, Logger, OutboundHttp, RequestId, Secret, ServiceId, ValidationIssue,
} from '@servicerouter/common';
import {
  canonicalJson, changesPayouts, checkAndCompileParsedServiceConfig, cryptoRandomSource, fetchOpenApiDocuments, findMovedSecrets,
  generateConfirmationToken, getSecretOrigins, getSecretUses, getUpstreamHosts, InvalidServiceConfigError, isSameRevision,
  ownershipRecheckIntervalMs, parseServiceConfig, payoutConfirmationTtlMs, SecretOriginMismatchError, ServiceForbiddenError,
  ServiceIdMismatchError, ServiceNotFoundError, stateForActivation, UnusedSecretError, type AuditEntry, type AuditLog, type InvalidationBus,
  type OwnershipServiceStatus, type OwnershipStatus, type OwnershipVerifier, type ParsedServiceConfig, type PlatformConfig, type RandomSource,
  type SealedSecret, type SecretSealer, type ServiceConfigDocument, type ServiceRecord, type ServiceRevisionSummary, type ServiceState,
  type StoredSecretInfo, type SubmittedConfig,
} from '@servicerouter/core';
import {
  createAuditLogRepository, createPayoutConfirmationRepository, createServiceRepository, createServiceSecretRepository, withTransaction,
  type Database, type DatabaseTransaction,
} from '@servicerouter/db';

import { createPublisher } from '../invalidation.js';
import type { SubmitBody } from './body.js';

export interface ServiceRegistryOptions {
  readonly db: Database;
  readonly platform: PlatformConfig;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly sealer: SecretSealer;
  // Fetches linked OpenAPI documents at submit time (SR-3)
  readonly http: Pick<OutboundHttp, 'request'>;
  readonly ownership: OwnershipStatus;
  // Checks the hosts' ownership files and reports the status (OV-6, OV-7)
  readonly verifier: OwnershipVerifier;
  // Randomness for payout confirmation tokens (OV-10). Default: node:crypto.
  readonly random?: RandomSource;
  readonly invalidation: Pick<InvalidationBus, 'publish'>;
  // The audit log inside a change's transaction. Default: the audit_log repository on it.
  readonly auditLog?: (tx: DatabaseTransaction) => AuditLog;
}

interface Caller {
  readonly accountId: string;
  readonly serviceId: string;
}

interface Change extends Caller {
  readonly requestId: RequestId;
}

/** A payout change waiting for its confirmation token on every upstream host (OV-10, SR-13). */
export interface WaitingPayoutChange {
  readonly revision: number;
  // `sr-confirm=…`
  readonly token: string;
  readonly expiresAt: Date;
}

export interface SubmitResult {
  // The submit created the service
  readonly created: boolean;
  // The active revision after the submit
  readonly revision: number;
  // False when the config equals the active revision's (SR-4)
  readonly changed: boolean;
  readonly state: ServiceState;
  readonly warnings: readonly ValidationIssue[];
  // Set when the submit changed `payouts`: the new revision waits, and the active one keeps serving
  readonly payoutConfirmation?: WaitingPayoutChange;
}

export interface ServiceView {
  readonly service: ServiceRecord;
  readonly revision: number;
  readonly submitted: SubmittedConfig;
  // Names and times only (SC-1)
  readonly secrets: readonly Pick<StoredSecretInfo, 'name' | 'updatedAt'>[];
}

export interface ActivationResult {
  readonly revision: number;
  readonly changed: boolean;
  readonly state: ServiceState;
  // Set when the rollback changes `payouts`: it waits, and the active revision keeps serving
  readonly payoutConfirmation?: WaitingPayoutChange;
}

export interface ServiceRegistry {
  /**
   * `PUT /v1/services/{id}` (SR-12, SC-9): validates the config, fetches its OpenAPI documents, seals
   * the secrets, and in one transaction writes the secrets, the revision, its activation, and the
   * audit entries. Publishes the invalidation event after the commit.
   */
  submit(input: Change & { readonly body: SubmitBody }): Promise<SubmitResult>;
  get(input: Caller): Promise<ServiceView>;
  /** Every revision, newest first, and which one is active. */
  listRevisions(input: Caller): Promise<{ readonly activeRevision: number; readonly revisions: readonly ServiceRevisionSummary[] }>;
  /** Activates another stored revision (SR-7). Refuses one whose upstreams use other origins than the stored secrets (SC-10). */
  rollback(input: Change & { readonly revision: number }): Promise<ActivationResult>;
  /** Seals one secret for the origin of the active revision's upstream that uses it (SC-1, SC-10). */
  putSecret(input: Change & { readonly name: string; readonly value: Secret }): Promise<Pick<StoredSecretInfo, 'name' | 'updatedAt'>>;
  /** `GET /v1/services/{id}/status` (OV-7, OV-10). */
  status(input: Caller): Promise<OwnershipServiceStatus>;
  /** `POST /v1/services/{id}/verify` (OV-6): checks every host now. */
  verify(input: Change): Promise<OwnershipServiceStatus>;
}

interface SealedForWrite {
  readonly name: string;
  readonly origin: string;
  readonly sealed: SealedSecret;
}

const notFound = (): ServiceNotFoundError => new ServiceNotFoundError('No such service');

export const createServiceRegistry = ({
  db,
  platform,
  clock,
  ids,
  logger,
  sealer,
  http,
  ownership,
  verifier,
  random = cryptoRandomSource,
  invalidation,
  auditLog = tx => createAuditLogRepository({ db: tx, clock, ids }),
}: ServiceRegistryOptions): ServiceRegistry => {
  const services = createServiceRepository({ db });
  const secrets = createServiceSecretRepository({ db });

  // The service, if the caller owns it. Another account's service is 403, an unknown one 404.
  const owned = async ({ accountId, serviceId }: Caller): Promise<ServiceRecord> => {
    const service = await services.find(serviceId);
    if (!service)
      throw notFound();
    if (service.ownerAccountId !== accountId)
      throw new ServiceForbiddenError();

    return service;
  };

  const entry = ({ accountId, serviceId, requestId }: Change) => (action: AuditEntry['action'], details: AuditEntry['details']): AuditEntry => ({
    actor: { kind: 'account', id: accountId },
    action,
    subject: { kind: 'service', id: serviceId },
    requestId,
    details,
  });

  // After the commit (SR-7, SC-7)
  const publishEvent = createPublisher({ invalidation, logger });
  const publish = (serviceId: string): Promise<void> => publishEvent({ kind: 'service', id: serviceId });

  /**
   * OV-10, SR-13: a revision that changes `payouts` waits for its confirmation token on every host, and
   * the active revision keeps serving. It replaces any waiting change, keeping its token when the
   * `payouts` are the same. The active revision must keep its secrets' hosts (SC-10).
   */
  const waitForConfirmation = async (tx: DatabaseTransaction, input: {
    readonly serviceId: string;
    readonly revision: number;
    readonly config: ServiceConfigDocument;
    readonly active: ServiceConfigDocument;
    readonly now: Date;
  }): Promise<WaitingPayoutChange> => {
    const stored = await createServiceSecretRepository({ db: tx }).list(input.serviceId);
    const moved = findMovedSecrets(input.active, new Map(stored.map(secret => [secret.name, secret.origin])));
    if (moved.length > 0)
      throw new SecretOriginMismatchError(moved);

    const confirmations = createPayoutConfirmationRepository({ db: tx });
    const waiting = await confirmations.find(input.serviceId);
    const keep = waiting !== undefined && canonicalJson(waiting.payouts) === canonicalJson(input.config.payouts);
    const token = keep ? waiting.token : generateConfirmationToken(random);
    const createdAt = keep ? waiting.createdAt : input.now;
    const expiresAt = keep ? waiting.expiresAt : new Date(input.now.getTime() + payoutConfirmationTtlMs);
    await confirmations.put({
      serviceId: input.serviceId as ServiceId,
      revision: input.revision,
      token,
      payouts: input.config.payouts,
      hosts: getUpstreamHosts(input.config),
      createdAt,
      expiresAt,
      nextCheckAt: new Date(input.now.getTime() + ownershipRecheckIntervalMs),
    });

    return { revision: input.revision, token, expiresAt };
  };

  // A newer submit or rollback replaces a waiting payout change (OV-10.5)
  const dropWaiting = async (tx: DatabaseTransaction, serviceId: string, audit: (action: AuditEntry['action'], details: AuditEntry['details']) => AuditEntry, replacedBy: number): Promise<void> => {
    const dropped = await createPayoutConfirmationRepository({ db: tx }).delete(serviceId);
    if (dropped)
      await auditLog(tx).append(audit('service.payout_change_drop', { revision: dropped.revision, replacedBy }));
  };

  // Pass 1, the service ID, unused secrets, then sealing (SC-9)
  const parseAndSeal = (serviceId: string, body: SubmitBody): { parsed: ParsedServiceConfig; sealed: readonly SealedForWrite[] } => {
    const result = parseServiceConfig(body.source);
    if (!result.ok)
      throw new InvalidServiceConfigError(body.locate(result.errors));

    const { parsed } = result;
    if (parsed.config.service.id !== serviceId)
      throw new ServiceIdMismatchError();

    const uses = getSecretUses(parsed.config);
    const unused = [...body.secrets].filter(([name, value]) => value !== null && !uses.has(name)).map(([name]) => name).sort();
    if (unused.length > 0)
      throw new UnusedSecretError(unused);

    // A secret sent to two origins has none to be sealed for: pass 2 refuses it
    const origins = getSecretOrigins(parsed.config);
    const sealed = [...body.secrets].flatMap(([name, value]): SealedForWrite[] => {
      const origin = origins.get(name);

      return value && origin
        ? [{ name, origin, sealed: sealer.seal({ serviceId: parsed.config.service.id as ServiceId, name, origin, value }) }]
        : [];
    });

    return { parsed, sealed };
  };

  return {
    submit: async ({ accountId, serviceId, requestId, body }) => {
      const sentNames = [...body.secrets].filter(([, value]) => value !== null).map(([name]) => name);
      const deleted = [...body.secrets].filter(([, value]) => value === null).map(([name]) => name);
      let existing: ServiceRecord | undefined;
      let prepared: ReturnType<typeof parseAndSeal>;
      try {
        // Another account's service gets 403 before any work is done for it
        existing = await services.find(serviceId);
        if (existing && existing.ownerAccountId !== accountId)
          throw new ServiceForbiddenError();

        prepared = parseAndSeal(serviceId, body);
      }
      finally {
        // Sealed or not, the plain values go now (SC-9)
        for (const value of body.secrets.values())
          value?.destroy();
      }
      const { parsed, sealed } = prepared;
      const id = parsed.config.service.id as ServiceId;

      // Pass 2 sees names and origins only: those already set plus those sent, minus deletes (SC-9, SC-10)
      const stored = existing ? await secrets.list(id) : [];
      const secretNames = new Set([...stored.map(secret => secret.name), ...sentNames].filter(name => !deleted.includes(name)));
      const storedSecretOrigins = new Map(stored
        .filter(secret => !sentNames.includes(secret.name) && !deleted.includes(secret.name))
        .map(secret => [secret.name, secret.origin]));

      const fetched = await fetchOpenApiDocuments(parsed, { http });
      if (!fetched.ok)
        throw new InvalidServiceConfigError(body.locate(fetched.errors));

      // The runtime is compiled to validate it (pass 3), then dropped: the proxy compiles its own (T07)
      const checked = checkAndCompileParsedServiceConfig(parsed, {
        platform,
        openapiDocuments: fetched.documents,
        secretNames,
        storedSecretOrigins,
        revision: 1,
        state: 'pending',
      });
      if (!checked.ok)
        throw new InvalidServiceConfigError(body.locate(checked.errors), body.locate(checked.warnings));

      const state = await stateForActivation(ownership, accountId, parsed.config);
      const now = clock.now();
      const audit = entry({ accountId, serviceId: id, requestId });

      const result = await withTransaction(db, async tx => {
        const repository = createServiceRepository({ db: tx });
        const secretRepository = createServiceSecretRepository({ db: tx });
        const log = auditLog(tx);
        const created = await repository.createIfMissing({ id, ownerAccountId: accountId, state, createdAt: now });
        const service = (await repository.lock(id))!;
        if (service.ownerAccountId !== accountId)
          throw new ServiceForbiddenError();

        const active = service.activeRevision === undefined ? undefined : await repository.findRevision(id, service.activeRevision);
        const changed = active === undefined || !isSameRevision(active, { config: parsed.config, openapiDocuments: fetched.documents });
        // The same config as the waiting payout change keeps waiting, with no new revision (OV-10)
        const waiting = changed ? await createPayoutConfirmationRepository({ db: tx }).find(id) : undefined;
        const waitingRevision = waiting && await repository.findRevision(id, waiting.revision);
        const sameAsWaiting = waitingRevision !== undefined && isSameRevision(waitingRevision, { config: parsed.config, openapiDocuments: fetched.documents });
        const revision = active !== undefined && !changed ? active.number : sameAsWaiting ? waitingRevision.number : await repository.latestRevisionNumber(id) + 1;
        await log.append(audit('service.submit', { revision, changed }));

        // Secrets belong to the service, so they apply even when the config is a no-op (SR-12, SC-9)
        for (const secret of sealed) {
          await secretRepository.put({ serviceId: id, name: secret.name, origin: secret.origin, sealed: secret.sealed, updatedAt: now });
          await log.append(audit('secret.write', { name: secret.name, origin: secret.origin, keyId: secret.sealed.keyId }));
        }
        for (const name of deleted) {
          if (await secretRepository.delete(id, name))
            await log.append(audit('secret.delete', { name }));
        }
        if (!changed) {
          await dropWaiting(tx, id, audit, revision);

          return { created, revision, changed, state: service.state };
        }
        if (sameAsWaiting && waiting) {
          return {
            created, revision: active!.number, changed, state: service.state,
            payoutConfirmation: { revision: waiting.revision, token: waiting.token, expiresAt: waiting.expiresAt },
          };
        }

        // Checked again under the lock: a secret written since validation must still match its host (SC-10)
        const moved = findMovedSecrets(parsed.config, new Map((await secretRepository.list(id)).map(secret => [secret.name, secret.origin])));
        if (moved.length > 0)
          throw new SecretOriginMismatchError(moved);

        await repository.insertRevision({
          serviceId: id,
          number: revision,
          submitted: body.submitted,
          config: parsed.config,
          openapiDocuments: fetched.documents,
          createdBy: accountId,
          createdAt: now,
        });
        // SR-13: an activation that changes `payouts` waits for its payout confirmation (OV-10), and the
        // active revision keeps serving
        if (active && changesPayouts(active.config, parsed.config)) {
          const payoutConfirmation = await waitForConfirmation(tx, { serviceId: id, revision, config: parsed.config, active: active.config, now });
          await log.append(audit('service.payout_change_wait', {
            revision, activeRevision: active.number, expiresAt: payoutConfirmation.expiresAt.toISOString(),
          }));

          return { created, revision: active.number, changed, state: service.state, payoutConfirmation };
        }

        await dropWaiting(tx, id, audit, revision);
        await repository.activate({ id, revision, hosts: getUpstreamHosts(parsed.config), state, updatedAt: now });
        await log.append(audit('service.activate', { revision, previousRevision: active?.number ?? null, state, payoutsChanged: false }));

        return { created, revision, changed, state };
      });

      // A waiting payout change changes nothing the proxy serves (OV-10)
      if ((result.changed && !result.payoutConfirmation) || sealed.length > 0 || deleted.length > 0)
        await publish(id);

      return { ...result, warnings: body.locate(checked.warnings) };
    },

    get: async caller => {
      const service = await owned(caller);
      const revision = await services.findRevision(service.id, service.activeRevision!);

      return {
        service,
        revision: revision!.number,
        submitted: revision!.submitted,
        secrets: (await secrets.list(service.id)).map(({ name, updatedAt }) => ({ name, updatedAt })),
      };
    },

    listRevisions: async caller => {
      const service = await owned(caller);

      return { activeRevision: service.activeRevision!, revisions: await services.listRevisions(service.id) };
    },

    rollback: async ({ accountId, serviceId, requestId, revision }) => {
      await owned({ accountId, serviceId });
      const target = await services.findRevision(serviceId, revision);
      if (!target)
        throw new ServiceNotFoundError(`The service has no revision ${revision}`);

      const state = await stateForActivation(ownership, accountId, target.config);
      const audit = entry({ accountId, serviceId, requestId });
      const result = await withTransaction(db, async tx => {
        const repository = createServiceRepository({ db: tx });
        const log = auditLog(tx);
        const service = (await repository.lock(serviceId))!;
        if (service.activeRevision === revision) {
          await log.append(audit('service.rollback', { revision, previousRevision: revision, changed: false }));

          return { revision, changed: false, state: service.state };
        }

        // The stored secrets are sealed for the active revision's hosts. Another host needs them sent again (SC-10).
        const stored = await createServiceSecretRepository({ db: tx }).list(serviceId);
        const moved = findMovedSecrets(target.config, new Map(stored.map(secret => [secret.name, secret.origin])));
        if (moved.length > 0)
          throw new SecretOriginMismatchError(moved);

        const active = service.activeRevision === undefined ? undefined : await repository.findRevision(serviceId, service.activeRevision);
        const now = clock.now();
        // SR-13: as on submit, a rollback that changes `payouts` waits for its payout confirmation (OV-10)
        if (active && changesPayouts(active.config, target.config)) {
          const payoutConfirmation = await waitForConfirmation(tx, { serviceId, revision, config: target.config, active: active.config, now });
          await log.append(audit('service.rollback', { revision, previousRevision: active.number, changed: false }));
          await log.append(audit('service.payout_change_wait', {
            revision, activeRevision: active.number, expiresAt: payoutConfirmation.expiresAt.toISOString(),
          }));

          return { revision: active.number, changed: false, state: service.state, payoutConfirmation };
        }

        await dropWaiting(tx, serviceId, audit, revision);
        await repository.activate({ id: serviceId, revision, hosts: getUpstreamHosts(target.config), state, updatedAt: now });
        await log.append(audit('service.rollback', { revision, previousRevision: service.activeRevision ?? null, changed: true }));
        await log.append(audit('service.activate', { revision, previousRevision: service.activeRevision ?? null, state, payoutsChanged: false }));

        return { revision, changed: true, state };
      });

      if (result.changed)
        await publish(serviceId);

      return result;
    },

    putSecret: async ({ accountId, serviceId, requestId, name, value }) => {
      try {
        await owned({ accountId, serviceId });
        const now = clock.now();
        await withTransaction(db, async tx => {
          const repository = createServiceRepository({ db: tx });
          const service = (await repository.lock(serviceId))!;
          const active = await repository.findRevision(serviceId, service.activeRevision!);
          // Sealed for the host the active revision sends it to (SC-10)
          const origin = getSecretOrigins(active!.config).get(name);
          if (!origin)
            throw new UnusedSecretError([name], 'the active revision');

          const sealed = sealer.seal({ serviceId: service.id, name, origin, value });
          await createServiceSecretRepository({ db: tx }).put({ serviceId, name, origin, sealed, updatedAt: now });
          await auditLog(tx).append(entry({ accountId, serviceId, requestId })('secret.write', { name, origin, keyId: sealed.keyId }));
        });
        await publish(serviceId);

        return { name, updatedAt: now };
      }
      finally {
        value.destroy();
      }
    },

    status: async caller => {
      await owned(caller);

      return verifier.status(caller.serviceId);
    },

    verify: async ({ accountId, serviceId, requestId }) => {
      await owned({ accountId, serviceId });

      return verifier.verifyService({ serviceId, actor: { kind: 'account', id: accountId }, requestId });
    },
  };
};
