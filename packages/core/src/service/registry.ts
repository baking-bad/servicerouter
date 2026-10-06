import type { ServiceId } from '@servicerouter/common';

import type { SealedSecret } from '../secrets/ports.js';
import type { ServiceConfigDocument } from './document.js';
import type { ServiceState } from './runtime.js';

// The Service registry's records (SR-4, SR-7, SR-8) and the Secrets' rows (SC-2, SC-10), and the
// repositories that store them.

export interface ServiceRecord {
  readonly id: ServiceId;
  readonly ownerAccountId: string;
  readonly state: ServiceState;
  // Set in the transaction that creates the service, so undefined only inside it
  readonly activeRevision: number | undefined;
  // The active revision's upstream hosts (OV-5). Empty until the first activation.
  readonly hosts: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A service in its owner's list (WB-8): the record, and the active revision's title. */
export interface OwnedService extends ServiceRecord {
  readonly title: string | undefined;
}

/** The config as the seller sent it, for the seller to read back (SR-4). */
export interface SubmittedConfig {
  // `application/yaml` or `application/json`
  readonly mediaType: string;
  readonly text: string;
}

/** A revision. Immutable once stored (SR-4). */
export interface ServiceRevision {
  readonly serviceId: ServiceId;
  // 1, 2, 3, … per service
  readonly number: number;
  readonly submitted: SubmittedConfig;
  // The parsed config, for compiling. Never holds a secret value, only names (SR-12).
  readonly config: ServiceConfigDocument;
  // The fetched OpenAPI documents, keyed by link (SR-3). Inline `paths` stay in `config`.
  readonly openapiDocuments: ReadonlyMap<string, unknown>;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface ServiceRevisionSummary {
  readonly number: number;
  readonly mediaType: string;
  readonly createdBy: string;
  readonly createdAt: Date;
}

/** What may be said about a stored secret (SC-1): never its value, a hash, or a length. */
export interface StoredSecretInfo {
  readonly name: string;
  // The upstream origin it is sealed for, in clear, so the API checks SC-10 without opening it
  readonly origin: string;
  readonly updatedAt: Date;
}

export interface StoredSecret extends StoredSecretInfo {
  readonly sealed: SealedSecret;
}

/**
 * Everything the proxy needs to compile and serve a service (SR-5, SC-5), read in one snapshot.
 * Compile `config` with `openapiDocuments` through `compileServiceRuntime`, then open each secret with
 * the `origin` of the compiled runtime upstream that uses it. Never open with `secrets[].origin`: that
 * copy is for the Platform API's checks, and only the runtime's origin keeps a secret on its host (SC-10).
 */
export interface ServingService {
  readonly serviceId: ServiceId;
  // The seller: who earns from its paid calls (LG-7)
  readonly ownerAccountId: string;
  readonly state: ServiceState;
  readonly revision: number;
  readonly config: ServiceConfigDocument;
  readonly openapiDocuments: ReadonlyMap<string, unknown>;
  readonly secrets: readonly StoredSecret[];
}

export interface NewService {
  readonly id: ServiceId;
  readonly ownerAccountId: string;
  readonly state: ServiceState;
  readonly createdAt: Date;
}

export type NewServiceRevision = ServiceRevision;

/** Port: the `services` and `service_revisions` tables (Service registry). */
export interface ServiceRepository {
  find(id: string): Promise<ServiceRecord | undefined>;
  /**
   * Reads the service and locks its row until the transaction ends. Every write to a service locks
   * it first, so revision numbers, the active pointer, and its secrets change one request at a time.
   */
  lock(id: string): Promise<ServiceRecord | undefined>;
  /** Inserts the service unless its ID exists. Returns whether it did. */
  createIfMissing(service: NewService): Promise<boolean>;
  /** Points the service at a stored revision (SR-7), with that revision's upstream hosts (OV-5). */
  activate(input: {
    readonly id: string;
    readonly revision: number;
    readonly hosts: readonly string[];
    readonly state: ServiceState;
    readonly updatedAt: Date;
  }): Promise<void>;
  /** Changes the state alone, after an ownership check (OV-5). */
  setState(input: { readonly id: string; readonly state: ServiceState; readonly updatedAt: Date }): Promise<void>;
  /** Every service in this state, by ID. */
  idsInState(state: ServiceState): Promise<readonly string[]>;
  /** The account's services whose active revision uses the host, each locked until the transaction ends (OV-5). */
  lockUsingHost(accountId: string, host: string): Promise<readonly ServiceRecord[]>;
  /** Stores a revision. There is no update or delete: revisions are immutable (SR-4). */
  insertRevision(revision: NewServiceRevision): Promise<void>;
  findRevision(id: string, number: number): Promise<ServiceRevision | undefined>;
  /** Every revision, newest first. */
  listRevisions(id: string): Promise<readonly ServiceRevisionSummary[]>;
  /** The highest revision number, or 0. */
  latestRevisionNumber(id: string): Promise<number>;
  /** An account's services, newest first, with their active revision's title (WB-8). */
  listByOwner(ownerAccountId: string): Promise<readonly OwnedService[]>;
  /**
   * Loads the active revision and the sealed secrets in one consistent snapshot, for the proxy's cache
   * (T07). Undefined for an unknown service. See `ServingService`: open each secret with the origin of
   * the compiled runtime's upstream, never with the stored one (SC-10).
   */
  loadForServing(id: string): Promise<ServingService | undefined>;
}

/** Port: the `service_secrets` table (Secrets). Write-only to the outside: values never come back (SC-1). */
export interface ServiceSecretRepository {
  /** Every stored secret of the service, by name, without its sealed value. */
  list(serviceId: string): Promise<readonly StoredSecretInfo[]>;
  /** The sealed secrets, for the proxy only. */
  listSealed(serviceId: string): Promise<readonly StoredSecret[]>;
  /** Inserts or replaces the secret. */
  put(secret: { readonly serviceId: string; readonly name: string; readonly origin: string; readonly sealed: SealedSecret; readonly updatedAt: Date }): Promise<void>;
  /** Deletes the secret. Returns whether it existed. */
  delete(serviceId: string, name: string): Promise<boolean>;
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value))
    return value.map(canonical);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));

  return value;
};

/** JSON text that is the same for equal JSON values, whatever their key order. */
export const canonicalJson = (value: unknown): string => JSON.stringify(canonical(value));

/**
 * Whether a submit would store the same revision as the active one (SR-4): the same parsed config and
 * the same OpenAPI documents. Formatting, comments, key order, and the media type don't count.
 */
export const isSameRevision = (
  active: Pick<ServiceRevision, 'config' | 'openapiDocuments'>,
  next: Pick<ServiceRevision, 'config' | 'openapiDocuments'>,
): boolean =>
  canonicalJson(active.config) === canonicalJson(next.config)
  && canonicalJson(Object.fromEntries(active.openapiDocuments)) === canonicalJson(Object.fromEntries(next.openapiDocuments));

/**
 * Whether activating `next` over `active` changes `payouts` (SR-13). The service's first activation
 * changes nothing: verifying its hosts covers it.
 */
export const changesPayouts = (active: ServiceConfigDocument | undefined, next: ServiceConfigDocument): boolean =>
  active !== undefined && canonicalJson(active.payouts) !== canonicalJson(next.payouts);
