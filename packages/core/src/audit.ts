import {
  findUnsafeValue, isRecord, isRequestId, Secret, ServiceRouterError, type RequestId, type ValuePath,
} from '@servicerouter/common';

import { toPointer } from './validation/issues.js';

/** A plain JSON value. Classes such as `Secret`, `Date`, or `bigint` amounts don't fit: format them first. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const auditActorKinds = ['account', 'internal_api', 'job'] as const;
export type AuditActorKind = typeof auditActorKinds[number];

/** Who did it: an account (its ID), the internal API (the calling app), or a system job (its name). */
export interface AuditActor {
  readonly kind: AuditActorKind;
  readonly id: string;
}

/** What it was done to, such as `{ kind: 'service', id: 'my-app' }`. */
export interface AuditSubject {
  readonly kind: string;
  readonly id: string;
}

// A stable dotted name, such as `service.submit` or `key.revoke`. Never rename one.
export type AuditAction = `${string}.${string}`;

export interface AuditEntry {
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly subject: AuditSubject;
  // Absent for work outside any request, such as a scheduled job
  readonly requestId?: RequestId;
  // Never a credential or a body. The audit log refuses a `Secret` anywhere in here.
  readonly details?: JsonObject;
}

/** An entry as stored, with the ID and time the audit log assigned. */
export interface AuditRecord {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly subject: AuditSubject;
  readonly requestId: RequestId | undefined;
  readonly details: JsonObject;
}

/**
 * Port: the one audit log for money movements, config changes, secret writes, key changes, account
 * recovery, and internal API calls (XC-4). Append-only. Implementations take the time from a Clock and
 * the ID from an IdGenerator (CK-5).
 */
export interface AuditLog {
  append(entry: AuditEntry): Promise<AuditRecord>;
}

export class InvalidAuditEntryError extends ServiceRouterError {
  readonly code = 'invalid_audit_entry';
}

const actionPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const subjectKindPattern = /^[a-z][a-z0-9_]*$/;
const maxNameLength = 64;
const maxIdLength = 256;

const valueAt = (value: unknown, path: ValuePath): unknown =>
  path.reduce<unknown>((current, segment) => isRecord(current) || Array.isArray(current)
    ? (current as Record<string | number, unknown>)[segment]
    : undefined, value);

const isName = (value: unknown, pattern: RegExp): boolean =>
  typeof value === 'string' && value.length <= maxNameLength && pattern.test(value);
const isId = (value: unknown): boolean =>
  typeof value === 'string' && value.length > 0 && value.length <= maxIdLength;

const findDetailsProblem = (details: unknown): string | undefined => {
  if (!isRecord(details))
    return 'details must be a JSON object';

  const unsafe = findUnsafeValue(details);
  if (!unsafe)
    return undefined;

  const pointer = toPointer(unsafe.path);

  return valueAt(details, unsafe.path) instanceof Secret
    ? `details${pointer} is a Secret. The audit log never stores credentials`
    : `details${pointer}: ${unsafe.message}`;
};

/** Throws InvalidAuditEntryError unless the entry can be stored as is. Every AuditLog calls it first. */
export const assertValidAuditEntry = (entry: AuditEntry): void => {
  const problems: string[] = [];
  if (!auditActorKinds.includes(entry.actor.kind))
    problems.push(`actor.kind must be one of: ${auditActorKinds.join(', ')}`);
  if (!isId(entry.actor.id))
    problems.push(`actor.id must be 1–${maxIdLength} characters`);
  if (!isName(entry.action, actionPattern))
    problems.push('action must be a dotted lowercase name, such as service.submit');
  if (!isName(entry.subject.kind, subjectKindPattern))
    problems.push('subject.kind must be a lowercase name, such as service');
  if (!isId(entry.subject.id))
    problems.push(`subject.id must be 1–${maxIdLength} characters`);
  if (entry.requestId !== undefined && !isRequestId(entry.requestId))
    problems.push('requestId is not a valid request ID');

  const detailsProblem = entry.details === undefined ? undefined : findDetailsProblem(entry.details);
  if (detailsProblem)
    problems.push(detailsProblem);

  if (problems.length > 0)
    throw new InvalidAuditEntryError(`Invalid audit entry: ${problems.join('; ')}`);
};
