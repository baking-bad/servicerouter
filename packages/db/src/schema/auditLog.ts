import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import type { AuditActorKind, AuditAction, JsonObject } from '@servicerouter/core';

// XC-4. Append-only: the repository has no update or delete. The ID and time come from the
// IdGenerator and Clock ports, never from column defaults (CK-5).
export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 }).notNull(),
  actorKind: text('actor_kind').$type<AuditActorKind>().notNull(),
  actorId: text('actor_id').notNull(),
  action: text('action').$type<AuditAction>().notNull(),
  subjectKind: text('subject_kind').notNull(),
  subjectId: text('subject_id').notNull(),
  requestId: text('request_id'),
  details: jsonb('details').$type<JsonObject>().notNull(),
}, table => [
  index('audit_log_subject_idx').on(table.subjectKind, table.subjectId, table.occurredAt),
  index('audit_log_actor_idx').on(table.actorKind, table.actorId, table.occurredAt),
]);
