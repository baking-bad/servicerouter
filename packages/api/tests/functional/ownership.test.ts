import { fixtureTime } from '@servicerouter/testing';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createAddressPolicy, createLogger, OutboundHttp, randomIdGenerator, Secret, type Clock, type Server,
} from '@servicerouter/common';
import {
  createOwnershipFileFetcher, createOwnershipVerifier, loadPlatformConfig, ownershipFileLimits, type InvalidationEvent, type OwnershipVerifier,
  type PlatformConfig,
} from '@servicerouter/core';
import {
  auditLog, createOwnershipStore, createRedisInvalidationBus, services, upstreamHosts, type RedisInvalidationBus,
} from '@servicerouter/db';
import {
  createFakeOwnershipFiles, createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, startFakeUpstream,
  type FakeOwnershipFiles, type FakeUpstream, type TestDatabase, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createApp, type ApiServer } from '../../src/app.js';

const loadConfig = () => loadPlatformConfig({
  env: {
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: Buffer.from(JSON.stringify({ rateLimits: { signup: { requests: 1000, windowSeconds: 60 } } })).toString('base64'),
  },
});

const hosts = ['api.example.com', 'example.com', 'files.example.com', 'other.example.com', 'big.example.com', 'hop.example.com'];
const payoutA = 'addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5';
const payoutB = 'addr_test1vqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygxrcya6';
const payoutC = 'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz';
const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const day = 24 * 60 * 60 * 1_000;

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let keys: TestSecretKeys;
let upstream: FakeUpstream;
let files: FakeOwnershipFiles;
let http: OutboundHttp;
let bus: RedisInvalidationBus;
let api: ApiServer;
let url: string;
let internalUrl: string;
let job: OwnershipVerifier;
const events: InvalidationEvent[] = [];
const logs: Record<string, unknown>[] = [];
const servers: Server[] = [];
let counter = 0;

// One millisecond per reading, so audit entries sort in the order they were written. `advance` moves days.
let tick = Date.parse(fixtureTime(-4, 1, 0, 0, 0, 0));
const clock: Clock = { now: () => new Date(tick++) };
const advance = (ms: number): void => {
  tick += ms;
};

const fileUrl = (host: string): string => upstream.url(host, '/.well-known/servicerouter.json');

beforeAll(async () => {
  [database, redis, config, keys, upstream] = await Promise.all([
    createTestDatabase(), createTestRedis(), loadConfig(), createTestSecretKeys(), startFakeUpstream({ hosts }),
  ]);
  files = createFakeOwnershipFiles();
  upstream.handle((request, response) => {
    if (!files.handle(request, response))
      response.writeHead(404).end();
  });
  // The fake upstream listens on 127.0.0.1: only this test's Outbound HTTP may reach loopback
  http = new OutboundHttp({
    ownHosts: config.ownHosts,
    resolver: createFakeResolver(Object.fromEntries(hosts.map(host => [host, '127.0.0.1']))),
    addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: upstream.ca,
    connectTimeoutMs: ownershipFileLimits.connectTimeoutMs,
  });
  bus = createRedisInvalidationBus({ redis, logger: createLogger({ level: 'silent' }) });
  await bus.subscribe(event => {
    events.push(event);
  });
  const logger = createLogger({}, { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) });
  api = createApp({
    config, logger, postgres: database.postgres, redis, clock, sealer: keys.sealer, openApiHttp: http, ownershipHttp: http, ownershipFileUrl: fileUrl,
    internalSecret: Secret.from(internalSecret),
  });
  servers.push(api);
  const addresses = await api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 });
  url = `http://127.0.0.1:${addresses.port}`;
  internalUrl = `http://127.0.0.1:${addresses.internalPort}`;
  // What the workers' daily job runs (OV-6), on the same database and clock
  job = createOwnershipVerifier({
    store: createOwnershipStore({ db: database.db, clock, ids: randomIdGenerator }),
    fetchFile: createOwnershipFileFetcher({ http, fileUrl }),
    clock,
    invalidation: bus,
    logger: createLogger({ level: 'silent' }),
  });
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await bus?.close();
  await http?.close();
  await upstream?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// --- Helpers ---

const signup = async (): Promise<string> => {
  const response = await fetch(`${url}/v1/accounts`, { method: 'POST' });

  return (await response.json() as { masterKey: string }).masterKey;
};

const accountOf = async (key: string): Promise<string> => {
  const response = await fetch(`${url}/v1/account`, { headers: { authorization: `Bearer ${key}` } });

  return (await response.json() as { id: string }).id;
};

const nextId = (): string => {
  counter += 1;

  return `own-${counter}`;
};

/** A config with one upstream per host, each with an inline path of its own. */
const serviceYaml = (id: string, upstreamHosts: readonly string[], { address = payoutA, amount = '0.001' } = {}): string => `servicerouter:
  version: "1"
service:
  id: ${id}
  title: Weather
  description: Weather forecasts.
  category: weather
payouts:
  default:
    asset: cardano-usdm
    address: ${address}
payments:
  default:
    amount: "${amount}"
upstreams:
${upstreamHosts.map((host, index) => `  - baseUrl: ${upstream.url(host, '')}
    name: u${index}
    paths:
      /p${index}:
        get:
          operationId: op${index}
`).join('')}`;

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const call = async (key: string, method: string, path: string, body?: string, contentType = 'application/yaml'): Promise<Answer> => {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...body === undefined ? {} : { 'content-type': contentType } },
    ...body === undefined ? {} : { body },
  });

  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const submit = (key: string, id: string, yaml: string) => call(key, 'PUT', `/v1/services/${id}`, yaml);
const verify = (key: string, id: string) => call(key, 'POST', `/v1/services/${id}/verify`);
const status = (key: string, id: string) => call(key, 'GET', `/v1/services/${id}/status`);
const tokenOf = async (key: string, id: string): Promise<string> => (await status(key, id)).body['verificationToken'] as string;
const serviceRow = async (id: string) => (await database.db.select().from(services).where(eq(services.id, id)))[0]!;
const actions = async (id: string) => (await database.db.select().from(auditLog).where(and(eq(auditLog.subjectKind, 'service'), eq(auditLog.subjectId, id))))
  .map(entry => entry.action);

/** A live service on these hosts, each listing the account's token. */
const liveService = async (key: string, serviceHosts: readonly string[], options?: { address?: string }): Promise<{ id: string; token: string }> => {
  const id = nextId();
  await submit(key, id, serviceYaml(id, serviceHosts, options));
  const token = await tokenOf(key, id);
  for (const host of serviceHosts)
    files.publishTokens(host, [token]);
  expect((await verify(key, id)).body['state']).toBe('live');
  await expect.poll(() => events).toContainEqual({ kind: 'service', id });

  return { id, token };
};

describe('verification (OV-1, OV-2, OV-5, OV-6, SR-8)', () => {
  it('keeps a new service pending until every host lists the account\'s token; verify then makes it live and announces it', async () => {
    const key = await signup();
    const id = nextId();

    const submitted = await submit(key, id, serviceYaml(id, ['api.example.com', 'files.example.com']));
    const before = await status(key, id);

    expect(submitted.body).toMatchObject({ revision: 1, state: 'pending' });
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      id, state: 'pending', revision: 1, verificationToken: expect.stringMatching(/^sr-verify=[0-9a-f]{32}$/), payoutConfirmation: null,
      hosts: [
        { host: 'api.example.com', state: 'unverified', checkedAt: null, problem: null },
        { host: 'files.example.com', state: 'unverified', checkedAt: null, problem: null },
      ],
      notices: [{ code: 'host_unverified', host: 'api.example.com' }, { code: 'host_unverified', host: 'files.example.com' }],
    });

    const token = before.body['verificationToken'] as string;
    files.publishTokens('api.example.com', ['sr-verify=someone-else', token]);
    files.remove('files.example.com');
    const half = await verify(key, id);

    expect(half.body).toMatchObject({
      state: 'pending',
      hosts: [{ host: 'api.example.com', state: 'verified', problem: null }, { host: 'files.example.com', state: 'unverified', problem: 'file_not_found' }],
    });

    files.publishTokens('files.example.com', [token]);
    const eventsBefore = events.length;
    const done = await verify(key, id);

    expect(done.body).toMatchObject({ state: 'live', hosts: [{ state: 'verified' }, { state: 'verified' }], notices: [] });
    expect((await serviceRow(id)).state).toBe('live');
    await expect.poll(() => events.slice(eventsBefore)).toContainEqual({ kind: 'service', id });
    expect(await actions(id)).toContain('service.state');
    // One token per account (OV-1): another service of the account shows the same one
    const other = nextId();
    await submit(key, other, serviceYaml(other, ['other.example.com']));
    expect(await tokenOf(key, other)).toBe(token);
  });

  it('verifies each host on its own: a token on api.example.com doesn\'t verify example.com (OV-3)', async () => {
    const key = await signup();
    const id = nextId();
    await submit(key, id, serviceYaml(id, ['example.com']));
    files.publishTokens('api.example.com', [await tokenOf(key, id)]);
    files.remove('example.com');

    const answer = await verify(key, id);

    expect(answer.body).toMatchObject({ state: 'pending', hosts: [{ host: 'example.com', state: 'unverified', problem: 'file_not_found' }] });
  });

  it('verifies a host per account: another account\'s token doesn\'t verify it for this one (OV-1, OV-3)', async () => {
    const [ownerKey, otherKey] = await Promise.all([signup(), signup()]);
    const owner = await liveService(ownerKey, ['other.example.com']);
    const id = nextId();
    await submit(otherKey, id, serviceYaml(id, ['other.example.com']));

    const refused = await verify(otherKey, id);
    files.publishTokens('other.example.com', [owner.token, await tokenOf(otherKey, id)]);
    const accepted = await verify(otherKey, id);

    expect(refused.body).toMatchObject({ state: 'pending', hosts: [{ state: 'unverified', problem: 'token_missing' }] });
    expect(accepted.body).toMatchObject({ state: 'live' });
    expect((await serviceRow(owner.id)).state).toBe('live');
  });

  it('answers 404 for an unknown service and 403 for another account\'s', async () => {
    const [ownerKey, otherKey] = await Promise.all([signup(), signup()]);
    const id = nextId();
    await submit(ownerKey, id, serviceYaml(id, ['api.example.com']));

    expect((await verify(otherKey, id)).status).toBe(403);
    expect((await status(otherKey, id)).status).toBe(403);
    expect((await verify(otherKey, 'no-such-service')).status).toBe(404);
  });
});

describe('a host that loses its token (OV-4, OV-5, OV-7)', () => {
  it('goes missing with a notice while the service stays live, is suspended after 7 days, and comes back with the token', async () => {
    const key = await signup();
    const { id, token } = await liveService(key, ['api.example.com', 'files.example.com']);
    files.publish('files.example.com', { version: 1, verification: [] });
    logs.length = 0;

    const missing = await verify(key, id);

    expect(missing.body).toMatchObject({
      state: 'live',
      hosts: [{ state: 'verified' }, { host: 'files.example.com', state: 'missing', problem: 'token_missing', suspendsAt: expect.any(String) }],
      notices: [{ code: 'host_missing', host: 'files.example.com' }],
    });
    const hosts = missing.body['hosts'] as { missingSince: string; suspendsAt: string }[];
    expect(Date.parse(hosts[1]!.suspendsAt) - Date.parse(hosts[1]!.missingSince)).toBe(7 * day);
    // OV-7: the notice is a log line too
    expect(logs).toContainEqual(expect.objectContaining({ host: 'files.example.com', from: 'verified', to: 'missing', notice: true }));

    // Six days on, the daily job still finds it missing: the service stays live
    advance(6 * day);
    await job.recheck({ actor: { kind: 'job', id: 'ownership_recheck' }, limit: 50 });
    expect((await serviceRow(id)).state).toBe('live');

    // At the end of the grace period, the job suspends the host and the service, and announces it
    advance(1 * day);
    const eventsBefore = events.length;
    const result = await job.recheck({ actor: { kind: 'job', id: 'ownership_recheck' }, limit: 50 });

    expect(result.failed).toBe(0);
    expect((await serviceRow(id)).state).toBe('suspended');
    await expect.poll(() => events.slice(eventsBefore)).toContainEqual({ kind: 'service', id });
    expect((await status(key, id)).body).toMatchObject({
      state: 'suspended', hosts: [{ state: 'verified' }, { state: 'suspended' }], notices: [{ code: 'host_suspended', host: 'files.example.com' }],
    });

    files.publishTokens('files.example.com', [token]);
    expect((await verify(key, id)).body).toMatchObject({ state: 'live', hosts: [{ state: 'verified' }, { state: 'verified' }] });
    const [row] = await database.db.select().from(upstreamHosts).where(eq(upstreamHosts.host, 'files.example.com'));
    expect(row).toBeDefined();
  });

  it('activates a revision with a suspended host as suspended (SR-8)', async () => {
    const key = await signup();
    const { id } = await liveService(key, ['big.example.com']);
    files.remove('big.example.com');
    await verify(key, id);
    advance(7 * day);
    await verify(key, id);

    const resubmitted = await submit(key, id, serviceYaml(id, ['big.example.com'], { amount: '0.002' }));

    expect(resubmitted.body).toMatchObject({ revision: 2, state: 'suspended' });
  });
});

describe('payout confirmation (OV-10, SR-13)', () => {
  it('keeps the active revision serving until every host lists the confirmation token, then activates the change', async () => {
    const key = await signup();
    const { id, token } = await liveService(key, ['api.example.com', 'files.example.com']);
    const eventsBefore = events.length;

    const changed = await submit(key, id, serviceYaml(id, ['api.example.com', 'files.example.com'], { address: payoutB }));
    const confirmation = changed.body['payoutConfirmation'] as { revision: number; token: string; expiresAt: string };

    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ revision: 1, changed: true, state: 'live' });
    expect(confirmation).toMatchObject({ revision: 2, token: expect.stringMatching(/^sr-confirm=[0-9a-f]{32}$/) });
    expect((await serviceRow(id)).activeRevision).toBe(1);
    expect(events.slice(eventsBefore)).not.toContainEqual({ kind: 'service', id });
    expect((await status(key, id)).body).toMatchObject({
      revision: 1,
      payoutConfirmation: { revision: 2, token: confirmation.token, hosts: [{ host: 'api.example.com', confirmed: false }, { host: 'files.example.com', confirmed: false }] },
      notices: [{ code: 'payout_change_waiting' }],
    });

    files.publishTokens('api.example.com', [token, confirmation.token]);
    const half = await verify(key, id);

    expect(half.body).toMatchObject({ revision: 1, payoutConfirmation: { hosts: [{ confirmed: true }, { confirmed: false }] } });

    files.publishTokens('files.example.com', [token, confirmation.token]);
    const done = await verify(key, id);

    expect(done.body).toMatchObject({ revision: 2, state: 'live', payoutConfirmation: null });
    expect((await serviceRow(id)).activeRevision).toBe(2);
    await expect.poll(() => events.slice(eventsBefore)).toContainEqual({ kind: 'service', id });
    expect(await actions(id)).toEqual(expect.arrayContaining(['service.payout_change_wait', 'service.payout_change_confirm', 'service.activate']));
  });

  it('follows a newer submit: the same payouts keep the token, other payouts get a new one, the active payouts activate at once (OV-10.5)', async () => {
    const key = await signup();
    const { id } = await liveService(key, ['api.example.com']);
    const hostsOf = ['api.example.com'];

    const first = (await submit(key, id, serviceYaml(id, hostsOf, { address: payoutB }))).body;
    const samePayouts = (await submit(key, id, serviceYaml(id, hostsOf, { address: payoutB, amount: '0.002' }))).body;
    const identical = (await submit(key, id, serviceYaml(id, hostsOf, { address: payoutB, amount: '0.002' }))).body;
    const otherPayouts = (await submit(key, id, serviceYaml(id, hostsOf, { address: payoutC }))).body;
    const tokenOfAnswer = (answer: Record<string, unknown>) => (answer['payoutConfirmation'] as { token: string; revision: number });

    expect(tokenOfAnswer(samePayouts).token).toBe(tokenOfAnswer(first).token);
    expect(tokenOfAnswer(samePayouts).revision).toBe(3);
    // The same config as the waiting change stores no new revision
    expect(tokenOfAnswer(identical)).toEqual(tokenOfAnswer(samePayouts));
    expect(tokenOfAnswer(otherPayouts).token).not.toBe(tokenOfAnswer(first).token);
    expect(tokenOfAnswer(otherPayouts).revision).toBe(4);

    const back = await submit(key, id, serviceYaml(id, hostsOf, { address: payoutA, amount: '0.003' }));

    expect(back.body).toMatchObject({ revision: 5, changed: true, state: 'live' });
    expect(back.body['payoutConfirmation']).toBeUndefined();
    expect((await serviceRow(id)).activeRevision).toBe(5);
    expect((await status(key, id)).body['payoutConfirmation']).toBeNull();
    expect(await actions(id)).toContain('service.payout_change_drop');
  });

  it('makes a rollback that changes payouts wait too', async () => {
    const key = await signup();
    const { id, token } = await liveService(key, ['api.example.com'], { address: payoutB });
    const change = (await submit(key, id, serviceYaml(id, ['api.example.com'], { address: payoutC }))).body['payoutConfirmation'] as { token: string };
    files.publishTokens('api.example.com', [token, change.token]);
    expect((await verify(key, id)).body).toMatchObject({ revision: 2 });

    const rollback = await call(key, 'POST', `/v1/services/${id}/rollback`, JSON.stringify({ revision: 1 }), 'application/json');

    expect(rollback.body).toMatchObject({ revision: 2, changed: false, payoutConfirmation: { revision: 1 } });
    expect((await serviceRow(id)).activeRevision).toBe(2);
  });

  it('drops an unconfirmed change after 7 days, and its token activates nothing afterwards (OV-10.4)', async () => {
    const key = await signup();
    const { id, token } = await liveService(key, ['hop.example.com']);
    const change = (await submit(key, id, serviceYaml(id, ['hop.example.com'], { address: payoutB }))).body['payoutConfirmation'] as { token: string };

    advance(7 * day);
    const result = await job.recheck({ actor: { kind: 'job', id: 'ownership_recheck' }, limit: 50 });
    files.publishTokens('hop.example.com', [token, change.token]);
    const after = await verify(key, id);

    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(after.body).toMatchObject({ revision: 1, payoutConfirmation: null });
    expect((await serviceRow(id)).activeRevision).toBe(1);
    expect(await actions(id)).toContain('service.payout_change_expire');
  });
});

describe('the internal verify action (OV-9, PA-4)', () => {
  const markVerified = (base: string, host: string, accountId: string) => fetch(`${base}/internal/v1/hosts/${host}/verify`, {
    method: 'POST',
    headers: { 'x-internal-secret': internalSecret, 'x-internal-caller': 'operator', 'content-type': 'application/json' },
    body: JSON.stringify({ accountId }),
  });

  it('marks a host verified for an account in staging, with an audit entry', async () => {
    const key = await signup();
    const accountId = await accountOf(key);
    const id = nextId();
    await submit(key, id, serviceYaml(id, ['example.com']));
    files.remove('example.com');

    const response = await markVerified(internalUrl, 'example.com', accountId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ host: 'example.com', accountId, state: 'verified', services: [{ id, state: 'live' }] });
    expect((await serviceRow(id)).state).toBe('live');
    const entries = await database.db.select().from(auditLog).where(and(eq(auditLog.action, 'ownership.mark_verified'), eq(auditLog.subjectId, 'example.com')));
    expect(entries).toMatchObject([{ actorKind: 'internal_api', actorId: 'operator' }]);
    expect((await markVerified(internalUrl, 'example.com', 'no-such-account')).status).toBe(404);
    expect((await markVerified(internalUrl, 'Not_A_Host', accountId)).status).toBe(400);
  });

  it('doesn\'t exist in production: 404', async () => {
    const production = createApp({
      config: { ...config, environment: 'production' }, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock,
      sealer: keys.sealer, openApiHttp: http, ownershipHttp: http, internalSecret: Secret.from(internalSecret),
    });
    servers.push(production);
    const addresses = await production.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 });
    const key = await signup();

    const response = await markVerified(`http://127.0.0.1:${addresses.internalPort}`, 'example.com', await accountOf(key));

    expect(response.status).toBe(404);
  });
});

describe('fetching the file (OV-2)', () => {
  it('refuses private addresses with the production policy, other hosts\' redirects, and oversized or broken files, quoting nothing', async () => {
    const production = new OutboundHttp({
      ownHosts: config.ownHosts,
      resolver: createFakeResolver(Object.fromEntries(hosts.map(host => [host, '127.0.0.1']))),
      ca: upstream.ca,
      connectTimeoutMs: ownershipFileLimits.connectTimeoutMs,
    });
    const strict = createOwnershipFileFetcher({ http: production, fileUrl });
    const fetchFile = createOwnershipFileFetcher({ http, fileUrl });
    files.answer('hop.example.com', { status: 302, location: upstream.url('other.example.com', '/.well-known/servicerouter.json') });
    files.answer('big.example.com', { status: 200, body: `{"version":1,"verification":["${'x'.repeat(ownershipFileLimits.maxBytes)}"]}` });
    files.answer('example.com', { status: 200, body: 'BODY-MARKER-do-not-echo' });
    try {
      const results = await Promise.all([
        strict('api.example.com'), fetchFile('hop.example.com'), fetchFile('big.example.com'), fetchFile('example.com'),
      ]);

      expect(results.map(result => !result.ok && result.problem)).toEqual(['fetch_failed', 'fetch_failed', 'fetch_failed', 'invalid_file']);
      for (const result of results)
        expect(JSON.stringify(result)).not.toContain('BODY-MARKER');
      expect(results[0]).toMatchObject({ reason: expect.stringContaining('api.example.com') });
    }
    finally {
      await production.close();
    }
  });
});
