import { fixtureTime } from '@servicerouter/testing';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAddressPolicy, createLogger, OutboundHttp, randomIdGenerator, type ServiceId } from '@servicerouter/common';
import {
  createOwnershipFileFetcher, createOwnershipVerifier, loadPlatformConfig, ownershipFileLimits, ownershipRecheckIntervalMs, type ServiceConfigDocument, type ServiceState,
} from '@servicerouter/core';
import { createAccountRepository, createOwnershipStore, createServiceRepository, services, upstreamHosts } from '@servicerouter/db';
import {
  createFakeClock, createFakeOwnershipFiles, createFakeResolver, createTestDatabase, startFakeUpstream, type FakeClock, type FakeOwnershipFiles,
  type FakeUpstream, type TestDatabase,
} from '@servicerouter/testing';

import { createOwnershipRecheck } from '../../src/ownershipRecheck.js';

const hosts = ['live.example.com', 'pending.example.com', 'suspended.example.com', 'later.example.com', 'b1.example.com', 'b2.example.com', 'b3.example.com'];
const day = 24 * 60 * 60 * 1_000;

let database: TestDatabase;
let clock: FakeClock;
let upstream: FakeUpstream;
let files: FakeOwnershipFiles;
let http: OutboundHttp;
let counter = 0;

beforeAll(async () => {
  const config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
  [database, upstream] = await Promise.all([createTestDatabase(), startFakeUpstream({ hosts })]);
  clock = createFakeClock(fixtureTime(-4, 1, 0, 0, 0, 0));
  files = createFakeOwnershipFiles();
  upstream.handle((request, response) => {
    if (!files.handle(request, response))
      response.writeHead(404).end();
  });
  http = new OutboundHttp({
    ownHosts: config.ownHosts,
    resolver: createFakeResolver(Object.fromEntries(hosts.map(host => [host, '127.0.0.1']))),
    addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: upstream.ca,
    connectTimeoutMs: ownershipFileLimits.connectTimeoutMs,
  });
});

afterAll(async () => {
  await http?.close();
  await upstream?.close();
  await database?.drop();
});

const store = () => createOwnershipStore({ db: database.db, clock, ids: randomIdGenerator });

const recheck = (batchSize = 50) => createOwnershipRecheck({
  verifier: createOwnershipVerifier({
    store: store(),
    fetchFile: createOwnershipFileFetcher({ http, fileUrl: host => upstream.url(host, '/.well-known/servicerouter.json') }),
    clock,
    invalidation: { publish: async () => undefined },
    logger: createLogger({ level: 'silent' }),
  }),
  batchSize,
});

const config = { upstreams: [] } as unknown as ServiceConfigDocument;

/** An account with a service in this state on these hosts, each host stored in `hostState`, due now. */
const seed = async (state: ServiceState, serviceHosts: readonly string[], hostState: 'verified' | 'unverified' | 'suspended', dueInMs = 0) => {
  counter += 1;
  const accountId = `acc_${counter}`;
  const id = `svc-${counter}` as ServiceId;
  await createAccountRepository({ db: database.db }).create({ id: accountId, email: undefined, createdAt: clock.now() });
  const repository = createServiceRepository({ db: database.db });
  await repository.createIfMissing({ id, ownerAccountId: accountId, state, createdAt: clock.now() });
  await repository.insertRevision({
    serviceId: id, number: 1, submitted: { mediaType: 'application/yaml', text: '' }, config, openapiDocuments: new Map(), createdBy: accountId,
    createdAt: clock.now(),
  });
  await repository.activate({ id, revision: 1, hosts: serviceHosts, state, updatedAt: clock.now() });
  for (const host of serviceHosts) {
    await database.db.insert(upstreamHosts).values({
      accountId, host, state: hostState, missingSince: hostState === 'suspended' ? clock.now() : null,
      nextCheckAt: new Date(clock.now().getTime() + dueInMs), updatedAt: clock.now(),
    });
  }

  return { accountId, id, token: await store().verificationToken(accountId) };
};

const hostRow = async (accountId: string, host: string) =>
  (await database.db.select().from(upstreamHosts).where(and(eq(upstreamHosts.accountId, accountId), eq(upstreamHosts.host, host))))[0]!;
const stateOf = async (id: string) => (await database.db.select().from(services).where(eq(services.id, id)))[0]!.state;

describe('the ownership re-check (OV-6, WK-2)', () => {
  it('checks the due hosts of live and suspended services only, and schedules each one a day later', async () => {
    const live = await seed('live', ['live.example.com'], 'verified');
    const pending = await seed('pending', ['pending.example.com'], 'unverified');
    const suspended = await seed('suspended', ['suspended.example.com'], 'suspended');
    const later = await seed('live', ['later.example.com'], 'verified', 3 * 60 * 60 * 1_000);
    files.publishTokens('live.example.com', [live.token]);
    files.publishTokens('pending.example.com', [pending.token]);
    files.publishTokens('suspended.example.com', [suspended.token]);
    files.publishTokens('later.example.com', [later.token]);

    const result = await recheck()();

    expect(result).toMatchObject({ hosts: 2, failed: 0 });
    expect(files.fetches('live.example.com')).toBe(1);
    expect(files.fetches('suspended.example.com')).toBe(1);
    // A pending service waits for its seller's verify; a host not yet due waits for its time
    expect(files.fetches('pending.example.com')).toBe(0);
    expect(files.fetches('later.example.com')).toBe(0);
    expect(await stateOf(suspended.id)).toBe('live');
    expect((await hostRow(live.accountId, 'live.example.com')).nextCheckAt.getTime() - clock.now().getTime()).toBe(ownershipRecheckIntervalMs);
    expect(ownershipRecheckIntervalMs).toBe(day);

    // A second run finds nothing due: each host is checked once a day
    await recheck()();
    expect(files.fetches('live.example.com')).toBe(1);
  });

  it('checks at most a batch of hosts per run, oldest due first, so the day\'s checks spread over its runs', async () => {
    const account = await seed('live', ['b1.example.com', 'b2.example.com', 'b3.example.com'], 'verified');
    for (const host of ['b1.example.com', 'b2.example.com', 'b3.example.com'])
      files.publishTokens(host, [account.token]);

    const first = await recheck(2)();
    const second = await recheck(2)();

    expect(first.hosts).toBe(2);
    expect(second.hosts).toBe(1);
    expect(['b1.example.com', 'b2.example.com', 'b3.example.com'].map(host => files.fetches(host))).toEqual([1, 1, 1]);
  });
});
