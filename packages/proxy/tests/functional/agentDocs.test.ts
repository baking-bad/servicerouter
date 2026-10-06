import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp as createApi, type ApiServer } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp, Secret } from '@servicerouter/common';
import { assumeHostsVerified, loadPlatformConfig, openApiFetchLimits, type PlatformConfig } from '@servicerouter/core';
import {
  createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, startFakeUpstream, type FakeUpstream, type TestDatabase,
  type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createApp, type ProxyServer } from '../../src/app.js';

const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const sellerOpenApi = {
  openapi: '3.1.0',
  info: { title: 'Weather', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/weather/{city}': {
      get: {
        operationId: 'getWeather',
        summary: 'Current weather',
        parameters: [{ name: 'city', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
  },
};

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let keys: TestSecretKeys;
let upstream: FakeUpstream;
let http: OutboundHttp;
let api: ApiServer;
let pendingApi: ApiServer;
let proxy: ProxyServer;
let apiUrl: string;
let pendingApiUrl: string;
let internalUrl: string;
let proxyUrl: string;

beforeAll(async () => {
  [database, redis, config, keys, upstream] = await Promise.all([
    createTestDatabase(), createTestRedis(),
    // The pay URL is the local proxy's, so an agent that reads only the document reaches it
    loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } }),
    createTestSecretKeys(), startFakeUpstream({ hosts: ['api.example.com'] }),
  ]);
  upstream.handle((request, response) => {
    if (request.path === '/v1/openapi.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(sellerOpenApi));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: request.path }));
  });
  http = new OutboundHttp({
    ownHosts: config.ownHosts,
    resolver: createFakeResolver({ 'api.example.com': '127.0.0.1' }),
    addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: upstream.ca,
    connectTimeoutMs: openApiFetchLimits.connectTimeoutMs,
  });
  const logger = createLogger({ level: 'silent' });
  proxy = createApp({ config, logger, postgres: database.postgres, redis, opener: keys.opener, http, buyerHeaderKey: Secret.from('buyer-header-key-for-the-agent-docs-tests') });
  const proxyPorts = await proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
  proxyUrl = `http://127.0.0.1:${proxyPorts.port}`;
  // The documents point at this proxy, as production's point at pay.servicerouter.ai
  const local = { ...config, urls: { ...config.urls, pay: proxyUrl } };
  api = createApi({ config: local, logger, postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: http, ownership: assumeHostsVerified, internalSecret: Secret.from(internalSecret) });
  pendingApi = createApi({ config: local, logger, postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: http, ownership: { hostStates: async () => new Map() } });
  const [apiPorts, pendingPorts] = await Promise.all([
    api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 }),
    pendingApi.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 }),
  ]);
  apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  internalUrl = `http://127.0.0.1:${apiPorts.internalPort!}`;
  pendingApiUrl = `http://127.0.0.1:${pendingPorts.port}`;
  await proxy.subscribed;
});

afterAll(async () => {
  await Promise.all([api?.close(), pendingApi?.close(), proxy?.close()]);
  await http?.close();
  await upstream?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const serviceYaml = (id: string, amount: string): string => `servicerouter:
  version: "1"
service:
  id: ${id}
  title: Weather
  summary: Current weather for any city
  description: Weather for any city.
  category: weather
payouts:
  default:
    asset: cardano-usdm
    address: addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5
payments:
  default:
    amount: "${amount}"
upstreams:
  - baseUrl: ${upstream.url('api.example.com', '/v1')}
    openapi: ${upstream.url('api.example.com', '/v1/openapi.json')}
`;

const signup = async (base = apiUrl) => await (await fetch(`${base}/v1/accounts`, { method: 'POST' })).json() as { id: string; masterKey: string };
const submit = (base: string, key: string, id: string, amount: string) => fetch(`${base}/v1/services/${id}`, {
  method: 'PUT', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/yaml' }, body: serviceYaml(id, amount),
});

describe('agent documents (AD-1, AD-2, AD-4, step 10)', () => {
  it('lets an agent that reads only the OpenAPI document call the service through the proxy, paying with a payment key', async () => {
    const seller = await signup();
    await submit(apiUrl, seller.masterKey, 'docs-weather', '0.002');
    const buyer = await signup();
    const { key } = await (await fetch(`${apiUrl}/v1/keys`, {
      method: 'POST', headers: { authorization: `Bearer ${buyer.masterKey}`, 'content-type': 'application/json' }, body: '{}',
    })).json() as { key: string };
    await fetch(`${internalUrl}/internal/v1/accounts/${buyer.id}/credits`, {
      method: 'POST', headers: { 'x-internal-secret': internalSecret, 'content-type': 'application/json' }, body: JSON.stringify({ amount: '1', reference: 'docs-test' }),
    });

    // No key is needed to read it
    const document = await (await fetch(`${apiUrl}/v1/services/docs-weather/openapi.json`)).json() as {
      servers: { url: string }[];
      paths: Record<string, { get: { 'x-payment-info': { price: string } } }>;
    };
    const [path] = Object.keys(document.paths);
    const called = await fetch(`${document.servers[0]!.url}${path!.replace('{city}', 'oslo')}`, { headers: { authorization: `Bearer ${key}` } });

    expect(document.paths[path!]!.get['x-payment-info'].price).toBe('0.002');
    expect(called.status).toBe(200);
    expect(await called.json()).toEqual({ path: '/v1/weather/oslo' });
    expect(called.headers.get('servicerouter-receipt')).toContain('amount="0.002"');
  });

  it('serves each document with an ETag, answers 304 to it, and makes new ones when a revision changes the price (AD-4)', async () => {
    const seller = await signup();
    await submit(apiUrl, seller.masterKey, 'docs-etag', '0.001');

    const first = await fetch(`${apiUrl}/v1/services/docs-etag/llms.txt`);
    const etag = first.headers.get('etag')!;
    const again = await fetch(`${apiUrl}/v1/services/docs-etag/llms.txt`, { headers: { 'if-none-match': etag } });
    await submit(apiUrl, seller.masterKey, 'docs-etag', '0.005');
    const changed = await fetch(`${apiUrl}/v1/services/docs-etag/llms.txt`, { headers: { 'if-none-match': etag } });

    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(await first.text()).toContain('$0.001');
    expect(again.status).toBe(304);
    expect(changed.status).toBe(200);
    expect(await changed.text()).toContain('$0.005');
    const skill = await fetch(`${apiUrl}/v1/services/docs-etag/skill.md`);
    expect(skill.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await skill.text()).toMatch(/^---\nname: docs-etag\n/);
  });

  it('answers 404 for a service that isn\'t live, or doesn\'t exist', async () => {
    const seller = await signup(pendingApiUrl);
    await submit(pendingApiUrl, seller.masterKey, 'docs-pending', '0.001');

    expect((await fetch(`${apiUrl}/v1/services/docs-pending/openapi.json`)).status).toBe(404);
    expect((await fetch(`${apiUrl}/v1/services/no-such-service/openapi.json`)).status).toBe(404);
  });
});
