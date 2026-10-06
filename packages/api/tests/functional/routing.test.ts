import { fixtureTime } from '@servicerouter/testing';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret, type ServiceId } from '@servicerouter/common';
import { loadPlatformConfig, type ServiceConfigDocument } from '@servicerouter/core';
import { auditLog, createAccountRepository, createRoutingRepository, createServiceRepository, maxRoutedEndpointsPerHost, routedEndpoints } from '@servicerouter/db';
import { createFakeClock, createTestDatabase, createTestRedis, createTestSecretKeys, type TestDatabase, type TestRedis } from '@servicerouter/testing';

import { createApp, type ApiServer } from '../../src/app.js';

const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const clock = createFakeClock(fixtureTime(0, 6, 0, 0, 0, 0));

let database: TestDatabase;
let redis: TestRedis;
let server: ApiServer;
let internalUrl: string;

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  const [config, keys] = await Promise.all([loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } }), createTestSecretKeys()]);
  server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock, sealer: keys.sealer, internalSecret: Secret.from(internalSecret) });
  internalUrl = `http://127.0.0.1:${(await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 })).internalPort!}`;
});

afterAll(async () => {
  await server?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const call = async (method: string, path: string, body: unknown) => {
  const response = await fetch(`${internalUrl}${path}`, {
    method,
    headers: { 'x-internal-secret': internalSecret, 'x-internal-caller': 'proxy', ...body === undefined ? {} : { 'content-type': 'application/json' } },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  });

  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

describe('routed endpoints and the blocklist on the internal API (RT-12, RT-13, RT-18, AR17)', () => {
  it('registers an endpoint once, without its query, and sets its own fee', async () => {
    const first = await call('PUT', '/internal/v1/routed-endpoints', { host: 'api.example.com', path: '/v1/pools' });
    const again = await call('PUT', '/internal/v1/routed-endpoints', { host: 'api.example.com', path: '/v1/pools' });
    const fee = await call('PUT', '/internal/v1/routed-endpoints/api.example.com/fee', { path: '/v1/pools', feeBps: 150 });
    const unknown = await call('PUT', '/internal/v1/routed-endpoints/api.example.com/fee', { path: '/v1/other', feeBps: 150 });

    expect([first.status, first.body['result']]).toEqual([201, 'created']);
    expect([again.status, again.body['result']]).toEqual([200, 'exists']);
    expect(fee).toEqual({ status: 200, body: { host: 'api.example.com', path: '/v1/pools', feeBps: 150 } });
    expect(unknown.status).toBe(404);
    expect(await createRoutingRepository({ db: database.db, clock }).endpointFee('api.example.com', '/v1/pools')).toBe(150);
  });

  it('never registers a registered service\'s host, and stops at 1,000 endpoints per host', async () => {
    const owner = `acc_${randomIdGenerator.next()}`;
    await createAccountRepository({ db: database.db }).create({ id: owner, email: undefined, createdAt: clock.now() });
    const services = createServiceRepository({ db: database.db });
    await services.createIfMissing({ id: 'svc-routing' as ServiceId, ownerAccountId: owner, state: 'live', createdAt: clock.now() });
    await services.insertRevision({ serviceId: 'svc-routing' as ServiceId, number: 1, submitted: { mediaType: 'application/yaml', text: '' }, config: { upstreams: [] } as unknown as ServiceConfigDocument, openapiDocuments: new Map(), createdBy: owner, createdAt: clock.now() });
    await services.activate({ id: 'svc-routing', revision: 1, hosts: ['seller.example.com'], state: 'live', updatedAt: clock.now() });
    await database.db.insert(routedEndpoints).values(Array.from({ length: maxRoutedEndpointsPerHost }, (_, index) => ({ host: 'busy.example.com', path: `/v1/tx/${index}`, createdAt: clock.now() })));

    expect((await call('PUT', '/internal/v1/routed-endpoints', { host: 'seller.example.com', path: '/v1/x' })).body['result']).toBe('service_host');
    expect((await call('PUT', '/internal/v1/routed-endpoints', { host: 'busy.example.com', path: '/v1/tx/new' })).body['result']).toBe('capped');
    expect((await call('PUT', '/internal/v1/routed-endpoints', { host: 'Not A Host', path: '/v1' })).status).toBe(400);
  });

  it('blocks and unblocks a host, with audit entries', async () => {
    const blocked = await call('PUT', '/internal/v1/blocklist/spam.example.com', { reason: 'abuse reports' });
    const routing = createRoutingRepository({ db: database.db, clock });

    expect(blocked.body).toEqual({ host: 'spam.example.com', blocked: true });
    expect(await routing.isBlocked('spam.example.com')).toBe(true);
    expect((await call('DELETE', '/internal/v1/blocklist/spam.example.com', undefined)).body).toEqual({ host: 'spam.example.com', blocked: false });
    expect(await routing.isBlocked('spam.example.com')).toBe(false);
    const actions = (await database.db.select().from(auditLog)).map(entry => entry.action);
    expect(actions).toEqual(expect.arrayContaining(['routing.block', 'routing.unblock', 'routing.endpoint_register', 'routing.endpoint_fee']));
  });
});
