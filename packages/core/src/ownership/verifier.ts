import { withTimeout, type Clock, type Logger, type ServiceId } from '@servicerouter/common';

import type { InvalidationBus } from '../invalidation.js';
import { ServiceNotFoundError } from '../service/errors.js';
import type { ServiceState } from '../service/runtime.js';
import type { FetchOwnershipFile, FetchOwnershipFileResult } from './fetch.js';
import type {
  ConfirmationOutcome, HostCheckRecorded, HostStatus, OwnershipActor, OwnershipStore, PayoutConfirmation,
} from './ports.js';
import { graceEndOf, type HostProblem, type HostState } from './state.js';

// How long a check waits to publish its invalidation event before it gives up and logs (SR-7)
const publishTimeoutMs = 2_000;
// Files fetched at once in one check
const fetchConcurrency = 8;

export interface HostStatusView extends HostStatus {
  // When a `missing` host is suspended unless its token comes back
  readonly suspendsAt: Date | undefined;
}

export interface PayoutConfirmationView {
  readonly revision: number;
  readonly token: string;
  readonly expiresAt: Date;
  readonly hosts: readonly { readonly host: string; readonly confirmed: boolean }[];
}

/** A notice to the seller (OV-7): a status field, and a log line when it starts. */
export interface OwnershipNotice {
  readonly code: 'host_unverified' | 'host_missing' | 'host_suspended' | 'payout_change_waiting';
  readonly host?: string;
  readonly message: string;
}

/** `GET /v1/services/{id}/status` (OV-7, OV-10). */
export interface OwnershipServiceStatus {
  readonly serviceId: ServiceId;
  readonly state: ServiceState;
  readonly revision: number;
  // The token every upstream host lists in its file (OV-1)
  readonly verificationToken: string;
  readonly hosts: readonly HostStatusView[];
  readonly payoutConfirmation: PayoutConfirmationView | undefined;
  readonly notices: readonly OwnershipNotice[];
}

export interface RecheckResult {
  readonly hosts: number;
  readonly confirmations: number;
  readonly expired: number;
  readonly failed: number;
}

export interface OwnershipVerifier {
  /** `POST /v1/services/{id}/verify` (OV-6): checks every host of the active and waiting revisions at once. */
  verifyService(input: OwnershipActor & { readonly serviceId: string }): Promise<OwnershipServiceStatus>;
  status(serviceId: string): Promise<OwnershipServiceStatus>;
  /** OV-9, staging only: marks a host verified for an account, as if its file listed the token. */
  markHostVerified(input: OwnershipActor & { readonly accountId: string; readonly host: string }): Promise<HostCheckRecorded>;
  /** One run of the daily re-check (OV-6): expired payout changes, then due hosts and confirmations. */
  recheck(input: OwnershipActor & { readonly limit: number }): Promise<RecheckResult>;
}

export interface OwnershipVerifierOptions {
  readonly store: OwnershipStore;
  readonly fetchFile: FetchOwnershipFile;
  readonly clock: Clock;
  readonly invalidation: Pick<InvalidationBus, 'publish'>;
  readonly logger: Logger;
}

/** Whether a fetched file lists a token, and why not. */
const lookFor = (result: FetchOwnershipFileResult, token: string): { readonly found: boolean; readonly problem: HostProblem | undefined } => {
  if (!result.ok)
    return { found: false, problem: result.problem };

  return result.file.verification.includes(token) ? { found: true, problem: undefined } : { found: false, problem: 'token_missing' };
};

/** Runs `work` on each item, at most `limit` at a time, keeping the order of the results. */
const mapLimited = async <TItem, TResult>(items: readonly TItem[], limit: number, work: (item: TItem) => Promise<TResult>): Promise<TResult[]> => {
  const results: TResult[] = new Array<TResult>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));

  return results;
};

const noticeFor = (status: HostStatusView): OwnershipNotice | undefined => {
  switch (status.state) {
    case 'unverified':
      return { code: 'host_unverified', host: status.host, message: `${status.host} doesn't list the account's verification token yet` };
    case 'missing':
      return {
        code: 'host_missing',
        host: status.host,
        message: `${status.host} no longer lists the verification token. The service is suspended at ${status.suspendsAt!.toISOString()} unless it comes back`,
      };
    case 'suspended':
      return { code: 'host_suspended', host: status.host, message: `${status.host} lost its verification token, so the service is suspended until it comes back` };
    default:
      return undefined;
  }
};

const changeMessages: Partial<Record<HostState, string>> = {
  verified: 'A host was verified',
  missing: 'A host no longer lists its verification token: its grace period starts',
  suspended: 'A host was suspended: its grace period ended without the token',
};

/**
 * Ownership verification (OV-1 to OV-10) on top of its store: fetches each host's file once per check,
 * applies the host states and the service states that follow, activates confirmed payout changes,
 * logs a notice for each change (OV-7), and publishes an invalidation event for each service whose
 * serving changed (OV-5). The Platform API and the workers' daily job share it.
 */
export const createOwnershipVerifier = ({ store, fetchFile, clock, invalidation, logger }: OwnershipVerifierOptions): OwnershipVerifier => {
  const publish = async (serviceId: string): Promise<void> => {
    try {
      await withTimeout(() => invalidation.publish({ kind: 'service', id: serviceId }), { timeoutMs: publishTimeoutMs });
    }
    catch (error) {
      logger.error({ error, serviceId }, 'Failed to publish an invalidation event');
    }
  };

  const announce = async (recorded: HostCheckRecorded): Promise<void> => {
    const { hostChange, serviceChanges } = recorded;
    if (hostChange) {
      const message = changeMessages[hostChange.to] ?? 'A host changed state';
      // OV-7: a notice is a status field and a log line
      logger.warn({ accountId: hostChange.accountId, host: hostChange.host, from: hostChange.from, to: hostChange.to, notice: true }, message);
    }
    for (const change of serviceChanges)
      logger.warn({ serviceId: change.serviceId, from: change.from, to: change.to, notice: true }, 'A service changed state after an ownership check');
    await Promise.all(serviceChanges.map(change => publish(change.serviceId)));
  };

  const announceConfirmation = async (serviceId: string, outcome: ConfirmationOutcome): Promise<void> => {
    if (outcome.kind === 'activated') {
      logger.warn({ serviceId, revision: outcome.revision, state: outcome.state, notice: true }, 'A confirmed payout change was activated');
      await publish(serviceId);
    }
    else if (outcome.kind === 'expired') {
      logger.warn({ serviceId, revision: outcome.revision, notice: true }, 'A payout change expired unconfirmed and was dropped');
    }
  };

  const checkHosts = async (accountId: string, token: string, hosts: readonly string[], who: OwnershipActor): Promise<ReadonlyMap<string, FetchOwnershipFileResult>> => {
    const fetched = await mapLimited(hosts, fetchConcurrency, async host => [host, await fetchFile(host)] as const);
    for (const [host, result] of fetched) {
      const { found, problem } = lookFor(result, token);
      // A seller's host that can't be read is an expected outcome: info (L-4)
      if (!result.ok)
        logger.info({ ...result.outbound, accountId, host, problem: result.problem, reason: result.reason }, 'An ownership file check failed');
      await announce(await store.recordHostCheck({ ...who, accountId, host, found, problem, now: clock.now() }));
    }

    return new Map(fetched);
  };

  const checkConfirmation = async (
    confirmation: PayoutConfirmation, files: ReadonlyMap<string, FetchOwnershipFileResult>, who: OwnershipActor,
  ): Promise<void> => {
    const confirmedHosts = confirmation.hosts.filter(host => {
      const result = files.get(host);

      return result !== undefined && lookFor(result, confirmation.token).found;
    });
    const outcome = await store.recordConfirmationCheck({
      ...who, serviceId: confirmation.serviceId, token: confirmation.token, confirmedHosts, now: clock.now(),
    });
    await announceConfirmation(confirmation.serviceId, outcome);
  };

  const status = async (serviceId: string): Promise<OwnershipServiceStatus> => {
    const service = await store.findService(serviceId);
    if (!service)
      throw new ServiceNotFoundError('No such service');

    const now = clock.now();
    const [verificationToken, confirmation] = await Promise.all([
      store.verificationToken(service.ownerAccountId),
      store.findConfirmation(serviceId),
    ]);
    const waiting = confirmation && confirmation.expiresAt > now ? confirmation : undefined;
    const stored = await store.hostStatuses(service.ownerAccountId, [...new Set([...service.hosts, ...waiting?.hosts ?? []])]);
    const view = (host: string): HostStatusView => {
      const status = stored.get(host) ?? { host, state: 'unverified', checkedAt: undefined, problem: undefined, missingSince: undefined };

      return { ...status, suspendsAt: status.state === 'missing' && status.missingSince ? graceEndOf(status.missingSince) : undefined };
    };
    const hosts = service.hosts.map(view);
    const notices = hosts.map(noticeFor).filter(notice => notice !== undefined);
    if (waiting) {
      notices.push({
        code: 'payout_change_waiting',
        message: `Revision ${waiting.revision} changes payouts. It activates once every upstream host lists ${waiting.token}, until ${waiting.expiresAt.toISOString()}`,
      });
    }

    return {
      serviceId: service.id,
      state: service.state,
      revision: service.activeRevision,
      verificationToken,
      hosts,
      payoutConfirmation: waiting && {
        revision: waiting.revision,
        token: waiting.token,
        expiresAt: waiting.expiresAt,
        hosts: waiting.hosts.map(host => ({ host, confirmed: waiting.confirmedHosts.includes(host) })),
      },
      notices,
    };
  };

  const verifyService = async ({ serviceId, ...who }: OwnershipActor & { readonly serviceId: string }): Promise<void> => {
    const service = await store.findService(serviceId);
    if (!service)
      throw new ServiceNotFoundError('No such service');

    const [token, confirmation] = await Promise.all([store.verificationToken(service.ownerAccountId), store.findConfirmation(serviceId)]);
    const hosts = [...new Set([...service.hosts, ...confirmation?.hosts ?? []])];
    const files = await checkHosts(service.ownerAccountId, token, hosts, who);
    if (confirmation)
      await checkConfirmation(confirmation, files, who);
  };

  return {
    verifyService: async input => {
      await verifyService(input);

      return status(input.serviceId);
    },

    status,

    markHostVerified: async ({ accountId, host, ...who }) => {
      const recorded = await store.recordHostCheck({ ...who, accountId, host, found: true, problem: undefined, now: clock.now() });
      await announce(recorded);

      return recorded;
    },

    recheck: async ({ limit, ...who }) => {
      const now = clock.now();
      const expired = await store.expireConfirmations({ ...who, now });
      for (const { serviceId, revision } of expired)
        await announceConfirmation(serviceId, { kind: 'expired', revision });

      let failed = 0;
      const due = await store.dueHosts({ now, limit });
      const byAccount = new Map<string, string[]>();
      for (const { accountId, host } of due)
        byAccount.set(accountId, [...byAccount.get(accountId) ?? [], host]);
      for (const [accountId, hosts] of byAccount) {
        try {
          await checkHosts(accountId, await store.verificationToken(accountId), hosts, who);
        }
        catch (error) {
          failed += hosts.length;
          logger.error({ error, accountId }, 'Failed to re-check an account\'s hosts');
        }
      }

      const confirmations = await store.dueConfirmations({ now, limit });
      for (const serviceId of confirmations) {
        try {
          await verifyService({ ...who, serviceId });
        }
        catch (error) {
          failed += 1;
          logger.error({ error, serviceId }, 'Failed to re-check a waiting payout change');
        }
      }

      return { hosts: due.length, confirmations: confirmations.length, expired: expired.length, failed };
    },
  };
};
