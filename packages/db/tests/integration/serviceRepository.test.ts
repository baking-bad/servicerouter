import { fixtureInstant } from '@servicerouter/testing';

import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ServiceId } from '@servicerouter/common';
import type { SealedSecret, ServiceConfigDocument, ServiceRevision } from '@servicerouter/core';
import { createTestDatabase, type TestDatabase } from '@servicerouter/testing';

import {
  createAccountRepository, createServiceRepository, createServiceSecretRepository, serviceRevisions, withSnapshot, withTransaction,
} from '../../src/index.js';

let database: TestDatabase;
let counter = 0;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

const at = (minute: number) => new Date(Date.parse(fixtureInstant) + minute * 60_000);

const config = (amount: string) => ({
  servicerouter: { version: '1' },
  service: { id: 'svc', title: 'Svc', description: 'A service', category: 'weather' },
  payouts: { default: { asset: 'cardano-usdm', address: 'addr_test1' } },
  payments: { default: { amount } },
  upstreams: [{ baseUrl: 'https://api.example.com', openapi: 'https://api.example.com/openapi.json', auth: 'main' }],
  credentials: { main: { type: 'http', scheme: 'bearer', secret: 'main-key' } },
}) as unknown as ServiceConfigDocument;

// Key order that JSONB would sort differently: JSON keeps it
const openapi = { paths: { '/zeta': {}, '/alpha': {}, '/mid': {} }, openapi: '3.1.0' };

const sealed = (): SealedSecret => ({
  version: 1,
  keyId: 'AAAAAAAAAAAAAAAAAAAAAA',
  wrappedKey: randomBytes(384),
  iv: randomBytes(12),
  ciphertext: randomBytes(20),
  tag: randomBytes(16),
});

const newService = async (): Promise<{ readonly id: ServiceId; readonly owner: string }> => {
  counter += 1;
  const owner = `acc_${counter}`;
  const id = `svc-${counter}` as ServiceId;
  await createAccountRepository({ db: database.db }).create({ id: owner, email: undefined, createdAt: at(0) });
  await withTransaction(database.db, async tx => {
    const repository = createServiceRepository({ db: tx });
    await repository.createIfMissing({ id, ownerAccountId: owner, state: 'live', createdAt: at(0) });
    await repository.insertRevision(revision(id, 1, owner));
    await repository.activate({ id, revision: 1, state: 'live', updatedAt: at(0) });
  });

  return { id, owner };
};

const revision = (serviceId: ServiceId, number: number, createdBy: string, amount = '0.001'): ServiceRevision => ({
  serviceId,
  number,
  submitted: { mediaType: 'application/yaml', text: `# revision ${number}\n` },
  config: config(amount),
  openapiDocuments: new Map([['https://api.example.com/openapi.json', openapi]]),
  createdBy,
  createdAt: at(number),
});

const pgError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  }
  catch (error) {
    return (error as { cause?: { code?: string; constraint?: string } }).cause ?? error;
  }
  throw new Error('Expected a rejection');
};

describe('services and revisions (SR-4, SR-7)', () => {
  it('stores a service with its first revision active', async () => {
    const { id, owner } = await newService();
    const services = createServiceRepository({ db: database.db });

    expect(await services.find(id)).toEqual({ id, ownerAccountId: owner, state: 'live', activeRevision: 1, createdAt: at(0), updatedAt: at(0) });
    expect(await services.find('missing')).toBeUndefined();
    expect(await services.createIfMissing({ id, ownerAccountId: 'acc_other', state: 'pending', createdAt: at(9) })).toBe(false);
    expect((await services.find(id))?.ownerAccountId).toBe(owner);
  });

  it('keeps a revision as submitted, its parsed config, and its OpenAPI snapshots in their key order (SR-3, SR-4)', async () => {
    const { id, owner } = await newService();

    const stored = await createServiceRepository({ db: database.db }).findRevision(id, 1);

    expect(stored).toEqual(revision(id, 1, owner));
    expect(Object.keys(stored!.openapiDocuments.get('https://api.example.com/openapi.json') as object)).toEqual(['paths', 'openapi']);
    expect(Object.keys((stored!.openapiDocuments.get('https://api.example.com/openapi.json') as typeof openapi).paths)).toEqual(['/zeta', '/alpha', '/mid']);
  });

  it('numbers revisions per service, lists them newest first, and moves the active pointer (SR-4, SR-7)', async () => {
    const { id, owner } = await newService();
    const services = createServiceRepository({ db: database.db });

    await services.insertRevision(revision(id, 2, owner, '0.002'));
    await services.activate({ id, revision: 2, state: 'pending', updatedAt: at(5) });

    expect(await services.latestRevisionNumber(id)).toBe(2);
    expect(await services.latestRevisionNumber('missing')).toBe(0);
    expect(await services.listRevisions(id)).toEqual([
      { number: 2, mediaType: 'application/yaml', createdBy: owner, createdAt: at(2) },
      { number: 1, mediaType: 'application/yaml', createdBy: owner, createdAt: at(1) },
    ]);
    expect(await services.find(id)).toMatchObject({ activeRevision: 2, state: 'pending', updatedAt: at(5) });
  });

  it('refuses a second revision with the same number, and has no way to change or delete one (SR-4)', async () => {
    const { id, owner } = await newService();
    const services = createServiceRepository({ db: database.db });

    expect(await pgError(services.insertRevision(revision(id, 1, owner, '0.5')))).toMatchObject({ code: '23505', constraint: 'service_revisions_pkey' });
    expect(Object.keys(services).filter(name => /update|delete|remove|replace/i.test(name))).toEqual([]);
    expect((await services.findRevision(id, 1))?.config).toEqual(config('0.001'));
  });

  it('refuses to point a service at a revision it doesn\'t have', async () => {
    const { id } = await newService();

    const error = await pgError(createServiceRepository({ db: database.db }).activate({ id, revision: 7, state: 'live', updatedAt: at(5) }));

    expect(error).toMatchObject({ code: '23503', constraint: 'services_active_revision_fk' });
  });

  it('locks the service row until the transaction ends, so writes to a service run one at a time', async () => {
    const { id } = await newService();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });

    const first = withTransaction(database.db, async tx => {
      await createServiceRepository({ db: tx }).lock(id);
      order.push('first locked');
      await held;
      order.push('first done');
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = withTransaction(database.db, async tx => {
      await createServiceRepository({ db: tx }).lock(id);
      order.push('second locked');
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    release();
    await Promise.all([first, second]);

    expect(order).toEqual(['first locked', 'first done', 'second locked']);
  });
});

describe('service secrets (SC-1, SC-2, SC-10)', () => {
  it('stores a sealed secret with its origin, replaces it, and lists names and times only', async () => {
    const { id } = await newService();
    const secrets = createServiceSecretRepository({ db: database.db });
    const first = sealed();
    const second = sealed();

    await secrets.put({ serviceId: id, name: 'main-key', origin: 'https://api.example.com', sealed: first, updatedAt: at(1) });
    await secrets.put({ serviceId: id, name: 'main-key', origin: 'https://moved.example.com', sealed: second, updatedAt: at(2) });

    expect(await secrets.list(id)).toEqual([{ name: 'main-key', origin: 'https://moved.example.com', updatedAt: at(2) }]);
    expect(await secrets.listSealed(id)).toEqual([{ name: 'main-key', origin: 'https://moved.example.com', updatedAt: at(2), sealed: second }]);
  });

  it('deletes a secret, and says whether it existed', async () => {
    const { id } = await newService();
    const secrets = createServiceSecretRepository({ db: database.db });
    await secrets.put({ serviceId: id, name: 'main-key', origin: 'https://api.example.com', sealed: sealed(), updatedAt: at(1) });

    expect(await secrets.delete(id, 'main-key')).toBe(true);
    expect(await secrets.delete(id, 'main-key')).toBe(false);
    expect(await secrets.list(id)).toEqual([]);
  });

  it('reads each byte field into memory of its own (backlog D-3)', async () => {
    const { id } = await newService();
    const secrets = createServiceSecretRepository({ db: database.db });
    await secrets.put({ serviceId: id, name: 'main-key', origin: 'https://api.example.com', sealed: sealed(), updatedAt: at(1) });

    const [stored] = await secrets.listSealed(id);
    const loaded = stored!.sealed;

    expect(Object.isFrozen(loaded)).toBe(true);
    for (const field of [loaded.wrappedKey, loaded.iv, loaded.ciphertext, loaded.tag]) {
      expect(field.byteOffset).toBe(0);
      expect(field.buffer.byteLength).toBe(field.byteLength);
    }
  });

  it('refuses a row whose origin isn\'t HTTPS', async () => {
    const { id } = await newService();

    const error = await pgError(createServiceSecretRepository({ db: database.db })
      .put({ serviceId: id, name: 'main-key', origin: 'http://api.example.com', sealed: sealed(), updatedAt: at(1) }));

    expect(error).toMatchObject({ code: '23514', constraint: 'service_secrets_origin_check' });
  });
});

describe('loadForServing (SR-5, SC-5, SC-10)', () => {
  it('loads the owner, the state, the active revision, its OpenAPI snapshots, and the sealed secrets with their stored origins', async () => {
    const { id, owner } = await newService();
    const services = createServiceRepository({ db: database.db });
    const secret = sealed();
    await services.insertRevision(revision(id, 2, owner, '0.002'));
    await services.activate({ id, revision: 2, state: 'live', updatedAt: at(3) });
    await createServiceSecretRepository({ db: database.db }).put({ serviceId: id, name: 'main-key', origin: 'https://api.example.com', sealed: secret, updatedAt: at(3) });

    expect(await services.loadForServing(id)).toEqual({
      serviceId: id,
      ownerAccountId: owner,
      state: 'live',
      revision: 2,
      config: config('0.002'),
      openapiDocuments: new Map([['https://api.example.com/openapi.json', openapi]]),
      secrets: [{ name: 'main-key', origin: 'https://api.example.com', updatedAt: at(3), sealed: secret }],
    });
    expect(await services.loadForServing('missing')).toBeUndefined();
  });

  it('reads in one snapshot (withSnapshot): a change committed between two reads doesn\'t show', async () => {
    const { id } = await newService();

    const seen = await withSnapshot(database.db, async tx => {
      const before = await createServiceSecretRepository({ db: tx }).list(id);
      // Another connection commits while the snapshot is open
      await createServiceSecretRepository({ db: database.db })
        .put({ serviceId: id, name: 'late', origin: 'https://api.example.com', sealed: sealed(), updatedAt: at(9) });
      const after = await createServiceSecretRepository({ db: tx }).list(id);
      const { rows: [mode] } = await tx.execute<{ isolation: string; readOnly: string }>(
        sql`select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as "readOnly"`);

      return { before, after, mode };
    });

    expect(seen).toEqual({ before: [], after: [], mode: { isolation: 'repeatable read', readOnly: 'on' } });
    expect((await createServiceRepository({ db: database.db }).loadForServing(id))?.secrets.map(secret => secret.name)).toEqual(['late']);
  });

  it('joins a caller\'s transaction instead of opening its own', async () => {
    const { id } = await newService();

    const loaded = await withTransaction(database.db, async tx => {
      await createServiceSecretRepository({ db: tx }).put({ serviceId: id, name: 'in-tx', origin: 'https://api.example.com', sealed: sealed(), updatedAt: at(4) });

      return createServiceRepository({ db: tx }).loadForServing(id);
    });

    expect(loaded?.secrets.map(secret => secret.name)).toEqual(['in-tx']);
  });
});

describe('the service_revisions table', () => {
  it('stores no secret value: only names reach the config column', async () => {
    const { id } = await newService();

    const [row] = await database.db.select({ config: serviceRevisions.config }).from(serviceRevisions)
      .where(sql`${serviceRevisions.serviceId} = ${id}`);

    expect(row?.config.credentials).toEqual({ main: { type: 'http', scheme: 'bearer', secret: 'main-key' } });
  });
});
