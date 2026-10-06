import { fixtureTime } from '@servicerouter/testing';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret, type Server } from '@servicerouter/common';
import { assumeHostsVerified, loadPlatformConfig, type PlatformConfig } from '@servicerouter/core';
import { createCatalogRepository, createServiceRepository, payments, routedEndpoints } from '@servicerouter/db';
import { createFakeClock, createTestDatabase, createTestRedis, createTestSecretKeys, type TestDatabase, type TestRedis } from '@servicerouter/testing';
import { createCatalogIndex, createServiceStats } from '@servicerouter/workers';

import { createApp } from '../../src/app.js';

const clock = createFakeClock(fixtureTime(0, 6, 0, 0, 0, 0));
const generous = { requests: 10_000, windowSeconds: 60 };

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let url: string;
const servers: Server[] = [];

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  config = await loadPlatformConfig({
    env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from(JSON.stringify({ rateLimits: { signup: generous, documents: generous } })).toString('base64') },
  });
  const keys = await createTestSecretKeys();
  const server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock, sealer: keys.sealer, ownership: assumeHostsVerified, internalSecret: Secret.from('internal-secret-0123456789abcdef-xyz') });
  servers.push(server);
  url = `http://127.0.0.1:${(await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const yaml = ({ id, title, category, amount, tags = [] as string[] }: { id: string; title: string; category: string; amount: string; tags?: string[] }) => `servicerouter:
  version: "1"
service:
  id: ${id}
  title: ${title}
  summary: ${title} for agents
  description: ${title}. Fresh data for any query.
  category: ${category}
  tags: [${tags.join(', ')}]
  links:
    homepage: https://example.com/${id}
payouts:
  default:
    asset: cardano-usdm
    address: addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5
payments:
  default:
    amount: "${amount}"
upstreams:
  - baseUrl: https://api.example.com
    name: main
    paths:
      /now:
        get:
          operationId: getNow
          summary: The current reading
          responses:
            200:
              description: OK
`;

let owner: string;
const submit = async (input: Parameters<typeof yaml>[0]) => {
  owner ??= (await (await fetch(`${url}/v1/accounts`, { method: 'POST' })).json() as { masterKey: string }).masterKey;
  const response = await fetch(`${url}/v1/services/${input.id}`, { method: 'PUT', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/yaml' }, body: yaml(input) });
  if (response.status >= 300)
    throw new Error(await response.text());
};

/** A decided call of a service's route, for the stats (CI-4). */
const call = async (serviceId: string, billable: boolean, latencyMs: number) => {
  await database.db.insert(payments).values({
    id: `pay_${randomIdGenerator.next()}`, kind: 'service', rail: 'credits', serviceId, routeKey: 'getNow', amount: 1_000n, fee: 0n,
    decision: billable ? 'billable' : 'not_billable', upstreamStatus: billable ? 200 : 500, upstreamLatencyMs: latencyMs,
    status: billable ? 'captured' : 'released', needsReview: false, createdAt: clock.now(), updatedAt: clock.now(),
  });
};

const reindex = async () => {
  const catalog = createCatalogRepository({ db: database.db, clock });
  await createCatalogIndex({ db: database.db, catalog, config, logger: createLogger({ level: 'silent' }) })();
  await createServiceStats({ catalog, clock })();
};

const list = async (query = '') => await (await fetch(`${url}/v1/catalog${query}`)).json() as { services: Record<string, any>[]; categories: Record<string, any>[]; next: string | null };

describe('the catalog (CI-1 to CI-5, step 13)', () => {
  beforeAll(async () => {
    await submit({ id: 'weather-now', title: 'Weather Now', category: 'weather', amount: '0.002', tags: ['forecast'] });
    await submit({ id: 'chain-data', title: 'Chain Data', category: 'blockchain', amount: '0.0005', tags: ['blocks'] });
    await submit({ id: 'weather-pro', title: 'Weather Pro', category: 'weather', amount: '0.01' });
    for (let index = 0; index < 5; index += 1)
      await call('chain-data', index < 4, 100 + index * 10);
    await call('weather-pro', true, 300);
    await call('weather-pro', true, 500);
    await database.db.insert(routedEndpoints).values({ host: 'api.target.dev', path: '/v1/pools', lastPrice: 1_100n, createdAt: clock.now() });
    await reindex();
  });

  it('lists live services, the most called first, then routed endpoints labeled unverified (CI-2, CI-5, AR14)', async () => {
    const page = await list();

    expect(page.services.map(item => [item['id'], item['verified']])).toEqual([
      ['chain-data', true], ['weather-pro', true], ['weather-now', true], ['routed:api.target.dev/v1/pools', false],
    ]);
    expect(page.services[0]).toMatchObject({
      title: 'Chain Data', summary: 'Chain Data for agents', category: 'blockchain', tags: ['blocks'], priceFrom: '0.0005', currency: 'USD',
      methods: ['credits', 'x402', 'mpp'], stats: { calls30d: 5, successRate: 0.8, p50Ms: 120, p95Ms: 138 },
    });
    expect(page.services[3]).toMatchObject({ priceFrom: '0.0011', verified: false, link: `${config.urls.pay}/api.target.dev/v1/pools` });
    expect(page.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'weather', count: 2 }), expect.objectContaining({ id: 'blockchain', count: 1 }),
    ]));
    expect(page.next).toBeNull();
  });

  it('filters by category, text, method, and price, sorts, and pages', async () => {
    expect((await list('?category=weather')).services.map(item => item['id'])).toEqual(['weather-pro', 'weather-now']);
    expect((await list('?q=forecast')).services.map(item => item['id'])).toEqual(['weather-now']);
    expect((await list('?maxPrice=0.001&method=credits')).services.map(item => item['id'])).toEqual(['chain-data']);
    expect((await list('?sort=price&category=weather')).services.map(item => item['id'])).toEqual(['weather-now', 'weather-pro']);
    const first = await list('?limit=2');
    const second = await list(`?limit=2&cursor=${first.next}`);
    expect([...first.services, ...second.services].map(item => item['id'])).toEqual(['chain-data', 'weather-pro', 'weather-now', 'routed:api.target.dev/v1/pools']);
    expect(second.next).toBeNull();
  });

  it('shows one service with its routes, prices, stats, documents, and pay URL', async () => {
    const service = await (await fetch(`${url}/v1/catalog/weather-pro`)).json();

    expect(service).toMatchObject({
      id: 'weather-pro', description: 'Weather Pro. Fresh data for any query.', links: { homepage: 'https://example.com/weather-pro' },
      routes: [{ key: 'getNow', method: 'GET', path: '/now', summary: 'The current reading', price: '0.01', stats: { calls30d: 2, successRate: 1 } }],
      docs: { openapi: `${config.urls.api}/v1/services/weather-pro/openapi.json` },
      payUrl: `${config.urls.pay}/service/weather-pro`,
    });
    expect((await fetch(`${url}/v1/catalog/no-such-service`)).status).toBe(404);
  });

  it('drops a suspended service, and shows a price change, at the next index run (CI-1)', async () => {
    await createServiceRepository({ db: database.db }).setState({ id: 'weather-now', state: 'suspended', updatedAt: clock.now() });
    await submit({ id: 'chain-data', title: 'Chain Data', category: 'blockchain', amount: '0.0007', tags: ['blocks'] });
    await reindex();

    const page = await list();

    expect(page.services.map(item => item['id'])).not.toContain('weather-now');
    expect(page.services.find(item => item['id'] === 'chain-data')?.['priceFrom']).toBe('0.0007');
    expect((await fetch(`${url}/v1/catalog/weather-now`)).status).toBe(404);
  });
});
