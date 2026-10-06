import type { Clock, IdGenerator } from '@servicerouter/common';
import { assertValidAuditEntry, type AuditLog, type AuditRecord } from '@servicerouter/core';

import type { DatabaseExecutor } from './postgres.js';
import { auditLog } from './schema/auditLog.js';

export interface AuditLogRepositoryOptions {
  // The database, or a transaction, so an entry commits with the change it records
  readonly db: DatabaseExecutor;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The audit log (XC-4). Append-only: there is no update or delete. Refuses an entry whose details hold
 * a `Secret` or anything else that isn't plain JSON, and writes nothing.
 */
export const createAuditLogRepository = ({ db, clock, ids }: AuditLogRepositoryOptions): AuditLog => ({
  append: async entry => {
    assertValidAuditEntry(entry);

    const record: AuditRecord = {
      id: ids.next(),
      occurredAt: clock.now(),
      actor: { kind: entry.actor.kind, id: entry.actor.id },
      action: entry.action,
      subject: { kind: entry.subject.kind, id: entry.subject.id },
      requestId: entry.requestId,
      details: entry.details ?? {},
    };
    await db.insert(auditLog).values({
      id: record.id,
      occurredAt: record.occurredAt,
      actorKind: record.actor.kind,
      actorId: record.actor.id,
      action: record.action,
      subjectKind: record.subject.kind,
      subjectId: record.subject.id,
      requestId: record.requestId ?? null,
      details: record.details,
    });

    return record;
  },
});
