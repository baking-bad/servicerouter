import { fixtureTime } from '@servicerouter/testing';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp as createApi, type ApiServer } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp, randomIdGenerator, Secret, type Clock } from '@servicerouter/common';
import {
  createOwnershipFileFetcher, createOwnershipVerifier, loadPlatformConfig, ownershipFileLimits, type OwnershipVerifier, type PlatformConfig,
} from '@servicerouter/core';
import { createOwnershipStore, createRedisInvalidationBus, type RedisInvalidationBus } from '@servicerouter/db';
import {
  createFakeOwnershipFiles, createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, startFakeUpstream,
  type FakeOwnershipFiles, type FakeUpstream, type TestDatabase, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createApp, type ProxyServer } from '../../src/app.js';

const hosts = ['api.example.com', 'files.example.com'];
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
let proxy: ProxyServer;
let apiUrl: string;
let proxyUrl: string;
let job: OwnershipVerifier;

let tick = Date.parse(fixtureTime(-4, 1, 0, 0, 0, 0));
const clock: Clock = { now: () => new Date(tick++) };
const fileUrl = (host: string): string => upstream.url(host, '/.well-known/servicerouter.json');

beforeAll(async () => {
  [database, redis, config, keys, upstream] = await Promise.all([
    createTestDatabase(), createTestRedis(),
    loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } }),
    createTestSecretKeys(), startFakeUpstream({ hosts }),
  ]);
  files = createFakeOwnershipFiles();
  upstream.handle((request, response) => {
    if (files.handle(request, response))
      return;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: request.path }));
  });
  http = new OutboundHttp({
    ownHosts: config.ownHosts,
    resolver: createFakeResolver(Object.fromEntries(hosts.map(host => [host, '127.0.0.1']))),
    addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: upstream.ca,
    connectTimeoutMs: ownershipFileLimits.connectTimeoutMs,
  });
  const logger = createLogger({ level: 'silent' });
  // The real ownership verification: the default OwnershipStatus reads upstream_hosts
  api = createApi({ config, logger, postgres: database.postgres, redis, clock, sealer: keys.sealer, openApiHttp: http, ownershipHttp: http, ownershipFileUrl: fileUrl });
  proxy = createApp({ config, logger, postgres: database.postgres, redis, opener: keys.opener, http, buyerHeaderKey: Secret.from('buyer-header-key-for-the-ownership-tests') });
  const [apiPorts, proxyPorts] = await Promise.all([
    api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 }),
    proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 }),
  ]);
  apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  proxyUrl = `http://127.0.0.1:${proxyPorts.port}`;
  await proxy.subscribed;
  bus = createRedisInvalidationBus({ redis, logger });
  job = createOwnershipVerifier({
    store: createOwnershipStore({ db: database.db, clock, ids: randomIdGenerator }),
    fetchFile: createOwnershipFileFetcher({ http, fileUrl }),
    clock,
    invalidation: bus,
    logger,
  });
});

afterAll(async () => {
  await Promise.all([api?.close(), proxy?.close()]);
  await bus?.close();
  await http?.close();
  await upstream?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const serviceYaml = (id: string): string => `servicerouter:
  version: "1"
service:
  id: ${id}
  title: Weather
  description: Weather forecasts.
  category: weather
payouts:
  default:
    asset: cardano-usdm
    address: addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5
payments:
  default:
    amount: "0"
upstreams:
  - baseUrl: ${upstream.url('api.example.com', '')}
    name: main
    paths:
      /weather:
        get:
          operationId: getWeather
          responses:
            200:
              description: OK
  - baseUrl: ${upstream.url('files.example.com', '')}
    name: files
    paths:
      /files:
        get:
          operationId: getFiles
          responses:
            200:
              description: OK
`;

describe('the proxy follows ownership (OV-4, OV-5, SR-8, PX-4, step 8)', () => {
  it('serves a service only once every host is verified, keeps it through the grace period, suspends it, and serves it again', async () => {
    const key = (await (await fetch(`${apiUrl}/v1/accounts`, { method: 'POST' })).json() as { masterKey: string }).masterKey;
    const headers = { authorization: `Bearer ${key}` };
    const id = 'owned-weather';
    await fetch(`${apiUrl}/v1/services/${id}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/yaml' }, body: serviceYaml(id) });
    const call = () => fetch(`${proxyUrl}/service/${id}/weather`);
    const verify = async () => (await (await fetch(`${apiUrl}/v1/services/${id}/verify`, { method: 'POST', headers })).json() as { state: string; verificationToken: string });

    // Pending: the proxy answers 404 (PX-4)
    expect((await call()).status).toBe(404);
    const { verificationToken: token } = await verify();
    files.publishTokens('api.example.com', [token]);
    expect((await verify()).state).toBe('pending');
    expect((await call()).status).toBe(404);

    // Every host verified: live, and the proxy serves it without a restart (OV-5)
    files.publishTokens('files.example.com', [token]);
    expect((await verify()).state).toBe('live');
    await expect.poll(async () => (await call()).status).toBe(200);

    // The token goes: missing, and still served during the grace period
    files.remove('files.example.com');
    expect((await verify()).state).toBe('live');
    expect((await call()).status).toBe(200);

    // After 7 days the job suspends it: 403 service_suspended
    tick += 7 * day;
    await job.recheck({ actor: { kind: 'job', id: 'ownership_recheck' }, limit: 50 });
    await expect.poll(async () => (await call()).status).toBe(403);
    expect(await (await call()).json()).toMatchObject({ error: { code: 'service_suspended' } });

    // The token comes back: live again
    files.publishTokens('files.example.com', [token]);
    expect((await verify()).state).toBe('live');
    await expect.poll(async () => (await call()).status).toBe(200);
  });
});
