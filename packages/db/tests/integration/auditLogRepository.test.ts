import { fixtureTime } from '@servicerouter/testing';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '@servicerouter/common';
import { InvalidAuditEntryError, type AuditEntry, type JsonObject } from '@servicerouter/core';
import { createFakeClock, createFakeIdGenerator, createTestDatabase, type TestDatabase } from '@servicerouter/testing';

import { auditLog, createAuditLogRepository, withTransaction } from '../../src/index.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

const entry = (subjectId: string, changes: Partial<AuditEntry> = {}): AuditEntry => ({
  actor: { kind: 'account', id: 'acc_1' },
  action: 'service.submit',
  subject: { kind: 'service', id: subjectId },
  requestId: 'req-1',
  ...changes,
});

const rowsFor = (subjectId: string) => database.db.select().from(auditLog)
  .where(eq(auditLog.subjectId, subjectId))
  .orderBy(auditLog.occurredAt, auditLog.id);

const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  }
  catch (error) {
    return error as Error;
  }
  throw new Error('Expected a rejection');
};

const setup = (idPrefix: string) => {
  const clock = createFakeClock(fixtureTime(-7, 1, 12, 0, 0, 0));
  const ids = createFakeIdGenerator(idPrefix);

  return { clock, ids, audit: createAuditLogRepository({ db: database.db, clock, ids }) };
};

describe('audit log repository (XC-4)', () => {
  it('appends an entry with the ID and time from the injected ports, and reads it back (XC-4, CK-5)', async () => {
    const { clock, audit } = setup('read-');
    const details = { revision: 3, hosts: ['api.example.com'], amount: '0.001', active: true, note: null };

    const first = await audit.append(entry('read-back', { details }));
    clock.advance(1_500);
    const second = await audit.append(entry('read-back', { actor: { kind: 'job', id: 'hold-expiry' }, action: 'service.activate', requestId: undefined }));

    expect(first).toEqual({
      id: 'read-1',
      occurredAt: new Date(fixtureTime(-7, 1, 12, 0, 0, 0)),
      actor: { kind: 'account', id: 'acc_1' },
      action: 'service.submit',
      subject: { kind: 'service', id: 'read-back' },
      requestId: 'req-1',
      details,
    });
    expect(second).toMatchObject({ id: 'read-2', occurredAt: new Date(fixtureTime(-7, 1, 12, 0, 1, 500)), requestId: undefined, details: {} });
    expect(await rowsFor('read-back')).toEqual([
      {
        id: 'read-1',
        occurredAt: new Date(fixtureTime(-7, 1, 12, 0, 0, 0)),
        actorKind: 'account',
        actorId: 'acc_1',
        action: 'service.submit',
        subjectKind: 'service',
        subjectId: 'read-back',
        requestId: 'req-1',
        details,
      },
      {
        id: 'read-2',
        occurredAt: new Date(fixtureTime(-7, 1, 12, 0, 1, 500)),
        actorKind: 'job',
        actorId: 'hold-expiry',
        action: 'service.activate',
        subjectKind: 'service',
        subjectId: 'read-back',
        requestId: null,
        details: {},
      },
    ]);
  });

  it('has no way to change or remove an entry: the port and the repository only append (XC-4)', () => {
    const { audit } = setup('only-');

    expect(Object.keys(audit)).toEqual(['append']);
  });

  it('rules out a Secret in the details at compile time (XC-4, CK-1)', () => {
    const details: JsonObject = {
      // @ts-expect-error A Secret isn't a JSON value, so the entry type refuses it
      apiKey: Secret.from('sk-live-123'),
    };

    expect(details).toBeDefined();
  });

  it.each([
    ['at the top', { apiKey: Secret.from('sk-live-123') }, '/apiKey'],
    ['in a nested object', { upstream: { auth: { token: Secret.from('sk-live-123') } } }, '/upstream/auth/token'],
    ['in an array', { keys: ['public', Secret.from('sk-live-123')] }, '/keys/1'],
  ])('refuses a Secret %s and writes nothing (XC-4, CK-1)', async (_name, details, pointer) => {
    const { ids, audit } = setup('secret-');
    const subjectId = `secret-${pointer}`;

    const error = await rejection(audit.append(entry(subjectId, { details: details as unknown as JsonObject })));

    expect(error).toBeInstanceOf(InvalidAuditEntryError);
    expect(error.message).toContain(`details${pointer} is a Secret`);
    expect(error.message).not.toContain('sk-live-123');
    expect(ids.issued).toEqual([]);
    expect(await rowsFor(subjectId)).toEqual([]);
  });

  it.each<[string, Partial<AuditEntry>, string]>([
    ['a bigint amount', { details: { amount: 1_000n } as unknown as JsonObject }, 'details/amount: only JSON values are supported'],
    ['a Date', { details: { at: new Date('2026-10-06T19:50:00+08:00') } as unknown as JsonObject }, 'details/at: only JSON values are supported'],
    ['a NUL character', { details: { note: 'a\0b' } }, 'details/note: strings must not contain NUL characters'],
    ['a prototype key', { details: JSON.parse('{"__proto__": {}}') as JsonObject }, 'details/__proto__: the key "__proto__" is not allowed'],
    ['details that are not an object', { details: ['a'] as unknown as JsonObject }, 'details must be a JSON object'],
    ['an unknown actor kind', { actor: { kind: 'admin' as 'account', id: 'x' } }, 'actor.kind must be one of: account, internal_api, job'],
    ['an empty actor ID', { actor: { kind: 'account', id: '' } }, 'actor.id must be 1–256 characters'],
    ['an action without a dot', { action: 'submit' as AuditEntry['action'] }, 'action must be a dotted lowercase name'],
    ['an action with capitals', { action: 'Service.Submit' as AuditEntry['action'] }, 'action must be a dotted lowercase name'],
    ['an invalid subject kind', { subject: { kind: 'Service', id: 'invalid-subject' } }, 'subject.kind must be a lowercase name'],
    ['an invalid request ID', { requestId: 'has spaces' }, 'requestId is not a valid request ID'],
  ])('refuses %s and writes nothing', async (name, changes, message) => {
    const { audit } = setup('invalid-');
    const value = entry(`invalid-${name}`, changes);

    expect(await rejection(audit.append(value))).toBeInstanceOf(InvalidAuditEntryError);
    await expect(audit.append(value)).rejects.toThrow(message);
    expect(await rowsFor(value.subject.id)).toEqual([]);
  });

  it('commits with the transaction it joins, and rolls back with it', async () => {
    const { clock, ids } = setup('tx-');

    await withTransaction(database.db, async tx => {
      const audit = createAuditLogRepository({ db: tx, clock, ids });
      await audit.append(entry('tx-commit'));
      await audit.append(entry('tx-commit', { action: 'service.activate' }));
    });
    const failure = withTransaction(database.db, async tx => {
      await createAuditLogRepository({ db: tx, clock, ids }).append(entry('tx-rollback'));
      throw new Error('the submit failed');
    });

    await expect(failure).rejects.toThrow('the submit failed');
    expect((await rowsFor('tx-commit')).map(row => row.action)).toEqual(['service.submit', 'service.activate']);
    expect(await rowsFor('tx-rollback')).toEqual([]);
  });
});
