import type { RequestId, ServiceId } from '@servicerouter/common';

import type { AuditActor } from '../audit.js';
import type { ServiceState } from '../service/runtime.js';
import type { HostProblem, HostState } from './state.js';

/** A host's stored state for one account (OV-4), with its last check. */
export interface HostStatus {
  readonly host: string;
  readonly state: HostState;
  readonly checkedAt: Date | undefined;
  // Why the last check didn't find the token. Undefined after a check that did.
  readonly problem: HostProblem | undefined;
  readonly missingSince: Date | undefined;
}

/** A payout change waiting for its confirmation token on every host (OV-10, SR-13). One per service. */
export interface PayoutConfirmation {
  readonly serviceId: ServiceId;
  // The waiting revision
  readonly revision: number;
  // `sr-confirm=…`
  readonly token: string;
  // The waiting revision's `payouts`, to tell whether a newer submit keeps the token (OV-10.5)
  readonly payouts: unknown;
  // The waiting revision's upstream hosts: each must list the token
  readonly hosts: readonly string[];
  // The hosts whose file listed the token at the last check
  readonly confirmedHosts: readonly string[];
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** Who acts, for the audit log: the seller through the API, an operator through the internal API, or the job. */
export interface OwnershipActor {
  readonly actor: AuditActor;
  readonly requestId?: RequestId;
}

export interface HostChange {
  readonly accountId: string;
  readonly host: string;
  readonly from: HostState;
  readonly to: HostState;
  readonly missingSince: Date | undefined;
}

export interface ServiceStateChange {
  readonly serviceId: ServiceId;
  readonly from: ServiceState;
  readonly to: ServiceState;
}

export interface HostCheckRecorded {
  // Undefined when the state stayed the same
  readonly hostChange: HostChange | undefined;
  // Every service whose state changed: each needs an invalidation event after the commit (OV-5)
  readonly serviceChanges: readonly ServiceStateChange[];
}

export type ConfirmationOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'waiting'; readonly confirmation: PayoutConfirmation }
  | { readonly kind: 'expired'; readonly revision: number }
  | { readonly kind: 'activated'; readonly revision: number; readonly state: ServiceState };

/** What ownership verification reads about a service: its owner, state, and active hosts. */
export interface OwnershipSubject {
  readonly id: ServiceId;
  readonly ownerAccountId: string;
  readonly state: ServiceState;
  readonly activeRevision: number;
  readonly hosts: readonly string[];
}

/**
 * Port: Ownership verification's storage (`verification_tokens`, `upstream_hosts`,
 * `payout_confirmations`), and the service state changes that follow a host's (OV-5). Each write is
 * one transaction, with its audit entries.
 */
export interface OwnershipStore {
  /** The account's verification token, created the first time it's asked for (OV-1). */
  verificationToken(accountId: string): Promise<string>;
  /** The stored state of each host that has one. A host without a record is `unverified`. */
  hostStatuses(accountId: string, hosts: readonly string[]): Promise<ReadonlyMap<string, HostStatus>>;
  findService(serviceId: string): Promise<OwnershipSubject | undefined>;
  findConfirmation(serviceId: string): Promise<PayoutConfirmation | undefined>;
  /**
   * Applies a check of one host (OV-4): its next state, and the state of every service of the account
   * that uses the host in its active revision (OV-5). Audited.
   */
  recordHostCheck(input: OwnershipActor & {
    readonly accountId: string;
    readonly host: string;
    readonly found: boolean;
    readonly problem: HostProblem | undefined;
    readonly now: Date;
  }): Promise<HostCheckRecorded>;
  /**
   * Applies a check of a waiting payout change (OV-10): records which hosts list its token, activates
   * it when every host does, and drops it once expired. Audited. `token` must still be the waiting one.
   */
  recordConfirmationCheck(input: OwnershipActor & {
    readonly serviceId: string;
    readonly token: string;
    readonly confirmedHosts: readonly string[];
    readonly now: Date;
  }): Promise<ConfirmationOutcome>;
  /** Drops every payout change past its expiry (OV-10.4). Audited. */
  expireConfirmations(input: OwnershipActor & { readonly now: Date }): Promise<readonly { readonly serviceId: ServiceId; readonly revision: number }[]>;
  /** Hosts of live or suspended services due for their daily check (OV-6), oldest first. */
  dueHosts(input: { readonly now: Date; readonly limit: number }): Promise<readonly { readonly accountId: string; readonly host: string }[]>;
  /** Services whose waiting payout change is due for its daily check (OV-6). */
  dueConfirmations(input: { readonly now: Date; readonly limit: number }): Promise<readonly ServiceId[]>;
}
