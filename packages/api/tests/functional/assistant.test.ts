import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAddressPolicy, createLogger, OutboundHttp, type Server } from '@servicerouter/common';
import { assumeHostsVerified, loadPlatformConfig, openApiFetchLimits, type LlmDrafter, type PlatformConfig } from '@servicerouter/core';
import { services } from '@servicerouter/db';
import {
  createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, startFakeUpstream, type FakeUpstream, type TestDatabase,
  type TestRedis,
} from '@servicerouter/testing';

import { createApp } from '../../src/app.js';

const payoutAddress = 'addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5';

let database: TestDatabase;
let redis: TestRedis;
let upstream: FakeUpstream;
let http: OutboundHttp;
let config: PlatformConfig;
let url: string;
const servers: Server[] = [];
const seen: unknown[] = [];

// The LLM, faked (step 14's done-when)
const drafter: LlmDrafter = {
  fill: async input => {
    seen.push(input);

    return { summary: 'Forecasts for agents', description: 'Weather forecasts for any city.', category: 'weather', tags: ['forecast'], prices: { getForecast: '0.003' } };
  },
};

beforeAll(async () => {
  [database, redis, upstream] = await Promise.all([createTestDatabase(), createTestRedis(), startFakeUpstream({ hosts: ['api.example.com'] })]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({ rateLimits: { signup: { requests: 1000, windowSeconds: 60 }, assistant: { requests: 3, windowSeconds: 3600 } } })).toString('base64'),
    },
  });
  upstream.handle((request, response) => {
    if (request.path !== '/openapi.json') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Forecast', version: '1' },
      servers: [{ url: upstream.url('api.example.com', '') }],
      paths: { '/forecast/{city}': { get: { operationId: 'getForecast', summary: '14-day forecast', responses: { 200: { description: 'OK' } } } } },
      components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } } },
    }));
  });
  http = new OutboundHttp({
    ownHosts: config.ownHosts, resolver: createFakeResolver({ 'api.example.com': '127.0.0.1' }), addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: upstream.ca, connectTimeoutMs: openApiFetchLimits.connectTimeoutMs,
  });
  const keys = await createTestSecretKeys();
  const server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: http, ownership: assumeHostsVerified, drafter });
  servers.push(server);
  url = `http://127.0.0.1:${(await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await http?.close();
  await upstream?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const signup = async () => (await (await fetch(`${url}/v1/accounts`, { method: 'POST' })).json() as { masterKey: string }).masterKey;
const draft = (key: string, body: unknown) => fetch(`${url}/v1/assistant/drafts`, {
  method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('POST /v1/assistant/drafts (CA-1 to CA-4, step 14)', () => {
  it('drafts a config from an OpenAPI link that a submit then takes as it is, and submits nothing itself', async () => {
    const key = await signup();
    const openapi = upstream.url('api.example.com', '/openapi.json');

    const response = await draft(key, { openapi, payoutAddress, id: 'forecast' });
    const body = await response.json() as { id: string; config: { mediaType: string; text: string }; submitted: boolean; notes: string[] };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: 'forecast', config: { mediaType: 'application/yaml' }, submitted: false });
    expect(body.config.text).toContain('category: weather');
    expect(body.config.text).toContain('amount: "0.003"');
    expect(seen).toHaveLength(1);
    // Nothing is stored or submitted
    expect(await database.db.select().from(services)).toEqual([]);

    const submitted = await fetch(`${url}/v1/services/forecast`, {
      method: 'PUT', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ config: body.config.text, secrets: { key: 'sk-test-0123456789' } }),
    });
    expect(submitted.status).toBe(201);
  });

  it('needs a master key, refuses a document it can\'t fetch quoting nothing, and limits drafts per account', async () => {
    const key = await signup();

    expect((await fetch(`${url}/v1/assistant/drafts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    const missing = await draft(key, { openapi: upstream.url('api.example.com', '/missing.json'), payoutAddress });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: 'invalid_request', message: expect.stringContaining('api.example.com answered with status 404') } });
    await draft(key, { openapi: upstream.url('api.example.com', '/openapi.json'), payoutAddress });
    await draft(key, { openapi: upstream.url('api.example.com', '/openapi.json'), payoutAddress });
    const limited = await draft(key, { openapi: upstream.url('api.example.com', '/openapi.json'), payoutAddress });
    expect(limited.status).toBe(429);
  });
});
