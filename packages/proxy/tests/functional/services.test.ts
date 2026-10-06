import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp as createApi } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp, Secret, type Server, type ServiceId } from '@servicerouter/common';
import { loadPlatformConfig, openApiFetchLimits, type PlatformConfig } from '@servicerouter/core';
import {
  createRedisInvalidationBus, createServiceRepository, createServiceSecretRepository, services, type RedisInvalidationBus,
} from '@servicerouter/db';
import {
  createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, dropRedisConnections, startFakeUpstream,
  type FakeResolver, type FakeUpstream, type TestDatabase, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createApp, type ProxyServer } from '../../src/app.js';

const loadConfig = () => loadPlatformConfig({
  env: {
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: Buffer.from(JSON.stringify({ rateLimits: { signup: { requests: 1000, windowSeconds: 60 } } })).toString('base64'),
  },
});

// Every failing upstream answer carries these. No client may see them (PX-7, rule 10).
const bodyMarker = 'BODY-MARKER-do-not-echo';
const headerMarker = 'x-upstream-detail';
const opaque503 = { error: { code: 'upstream_unavailable', message: 'The upstream is unavailable' } };
const upstreamTimeoutMs = 500;

const openapi = {
  openapi: '3.1.0',
  info: { title: 'Weather', version: '1.0.0' },
  paths: {
    '/weather/{city}': { get: { operationId: 'getWeather', responses: { 200: { description: 'OK' } } } },
    '/forecast/{city}': { get: { operationId: 'getForecast', responses: { 200: { description: 'OK' } } } },
    '/echo': { post: { operationId: 'echo', responses: { 200: { description: 'OK' } } } },
    '/redirect': { get: { operationId: 'redirect', responses: { 302: { description: 'Found' } } } },
    '/teapot': { get: { operationId: 'teapot', responses: { 200: { description: 'OK' } } } },
    '/slow': { get: { operationId: 'slow', responses: { 200: { description: 'OK' } } } },
    '/reset': { get: { operationId: 'reset', responses: { 200: { description: 'OK' } } } },
    '/anything': { get: { operationId: 'anything', responses: { default: { description: 'Any' } } } },
    '/admin/reset': { post: { operationId: 'adminReset', responses: { 200: { description: 'OK' } } } },
  },
};

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let keys: TestSecretKeys;
let upstream: FakeUpstream;
let resolver: FakeResolver;
let apiHttp: OutboundHttp;
let proxyHttp: OutboundHttp;
let observer: RedisInvalidationBus;
let api: Server;
let proxy: ProxyServer;
let apiUrl: string;
let proxyUrl: string;
let proxyPort: number;
let metricsUrl: string;
const logs: Record<string, unknown>[] = [];
let counter = 0;

const logger = createLogger({}, { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) });

beforeAll(async () => {
  [database, redis, config, keys, upstream] = await Promise.all([
    createTestDatabase(), createTestRedis(), loadConfig(), createTestSecretKeys(),
    startFakeUpstream({ hosts: ['api.example.com', 'files.example.com', 'moved.example.com', 'private.example.com'] }),
  ]);
  upstream.handle((request, response) => {
    const path = request.path.split('?')[0];
    if (path === '/openapi.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(openapi));
    }
    else if (path === '/v2/redirect') {
      response.writeHead(302, {
        location: upstream.url('api.example.com', '/v2/weather/oslo'),
        'content-location': upstream.url('api.example.com', '/internal/v1/state'),
        link: `<${upstream.url('api.example.com', '/v2/weather/bergen')}>; rel="alternate", <https://docs.example.net/weather>; rel="help"`,
        'set-cookie': 'session=upstream; Path=/',
        [headerMarker]: 'nginx at 10.0.0.5',
      }).end();
    }
    else if (path === '/v2/teapot') {
      response.writeHead(418, { [headerMarker]: 'teapot', 'content-type': 'text/plain' }).end(bodyMarker);
    }
    else if (path === '/v2/slow') {
      const timer = setTimeout(() => response.writeHead(200, { [headerMarker]: 'slow' }).end(bodyMarker), upstreamTimeoutMs * 4);
      response.on('close', () => clearTimeout(timer));
    }
    else if (path === '/v2/reset')
      response.socket?.destroy();
    else if (path === '/v2/anything')
      response.writeHead(207, { 'content-type': 'text/plain' }).end('multi');
    else {
      response.writeHead(path === '/upload' ? 201 : 200, {
        'content-type': 'application/json',
        'set-cookie': 'tracking=1',
        server: 'upstream/1.0',
        [headerMarker]: 'internal',
      });
      response.end(JSON.stringify({ method: request.method, path: request.path, host: request.servername }));
    }
  });
  resolver = createFakeResolver({
    'api.example.com': '127.0.0.1',
    'files.example.com': '127.0.0.1',
    'moved.example.com': '127.0.0.1',
    'private.example.com': '10.0.0.5',
  });
  // The fake upstream listens on 127.0.0.1: only these clients may reach loopback, and still not 10.0.0.0/8
  const outbound = { ownHosts: config.ownHosts, resolver, addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }), ca: upstream.ca };
  apiHttp = new OutboundHttp({ ...outbound, connectTimeoutMs: openApiFetchLimits.connectTimeoutMs });
  proxyHttp = new OutboundHttp({
    ...outbound,
    connectTimeoutMs: config.timeouts.connectMs,
    totalTimeoutMs: upstreamTimeoutMs,
    maxRequestBytes: config.sizeLimits.requestBodyBytes,
    maxResponseBytes: config.sizeLimits.bufferedResponseBytes,
  });

  api = createApi({ config, logger, postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: apiHttp });
  proxy = createApp({
    config, logger, postgres: database.postgres, redis, opener: keys.opener, http: proxyHttp, buyerHeaderKey: Secret.from('buyer-header-key-for-the-services-tests'),
  });
  const [apiPorts, proxyPorts] = await Promise.all([
    api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 }),
    proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 }),
  ]);
  apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  proxyPort = proxyPorts.port;
  proxyUrl = `http://127.0.0.1:${proxyPort}`;
  metricsUrl = `http://127.0.0.1:${proxyPorts.metricsPort}`;
  await proxy.subscribed;
  observer = createRedisInvalidationBus({ redis, logger: createLogger({ level: 'silent' }) });
});

afterAll(async () => {
  await Promise.all([api?.close(), proxy?.close()]);
  await observer?.close();
  await Promise.all([apiHttp?.close(), proxyHttp?.close(), upstream?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// --- Helpers ---

const nextId = (): ServiceId => {
  counter += 1;

  return `svc-${counter}` as ServiceId;
};

interface ConfigOptions {
  readonly id: string;
  readonly mainHost?: string;
  readonly filesHost?: string;
  readonly forecastTarget?: string;
  readonly adminEnabled?: boolean;
}

const serviceYaml = ({ id, mainHost = 'api.example.com', filesHost = 'files.example.com', forecastTarget = '/internal/forecast/{city}', adminEnabled = false }: ConfigOptions): string => `servicerouter:
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

# Free: these tests cover forwarding. Paid calls are in payments.test.ts.
payments:
  default:
    amount: "0"

upstreams:
  - baseUrl: ${upstream.url(mainHost, '/v2')}
    name: main
    openapi: ${upstream.url('api.example.com', '/openapi.json')}
    auth: main-key

  - baseUrl: ${upstream.url(filesHost, '')}
    name: files
    paths:
      /upload:
        post:
          operationId: uploadFile
          responses: { "201": { description: Created } }
    auth: [files-key, files-query]

routes:
  getForecast:
    target:
      path: ${forecastTarget}
  adminReset:
    enabled: ${adminEnabled}

credentials:
  main-key:
    type: http
    scheme: bearer
    secret: weather-key
  files-key:
    type: apiKey
    in: header
    name: X-Api-Key
    secret: files-key
  files-query:
    type: apiKey
    in: query
    name: key
    secret: files-query-key
`;

const origin = (host: string) => new URL(upstream.url(host)).origin;
const secretValue = (label: string) => `sk-${label}-${counter}-${Math.random().toString(36).slice(2)}`;

let masterKey: string | undefined;
const signup = async (): Promise<string> => {
  masterKey ??= (await (await fetch(`${apiUrl}/v1/accounts`, { method: 'POST' })).json() as { masterKey: string }).masterKey;

  return masterKey;
};

const apiCall = async (method: string, path: string, body: string, contentType = 'application/json'): Promise<Record<string, unknown>> => {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${await signup()}`, 'content-type': contentType },
    body,
  });
  const answer = await response.json() as Record<string, unknown>;
  if (!response.ok)
    throw new Error(`The API answered ${response.status}: ${JSON.stringify(answer)}`);

  return answer;
};

interface Secrets {
  readonly weather: string;
  readonly files: string;
  readonly query: string;
}

/** Submits a config through the API with all three secrets, as a seller would. */
const createService = async (options: Partial<ConfigOptions> = {}): Promise<{ readonly id: ServiceId; readonly secrets: Secrets }> => {
  const id = options.id as ServiceId | undefined ?? nextId();
  const secrets = { weather: secretValue('weather'), files: secretValue('files'), query: secretValue('query q/=') };
  await apiCall('PUT', `/v1/services/${id}`, JSON.stringify({
    config: serviceYaml({ ...options, id }),
    secrets: { 'weather-key': secrets.weather, 'files-key': secrets.files, 'files-query-key': secrets.query },
  }));

  return { id, secrets };
};

const metricsText = async (): Promise<string> => (await fetch(`${metricsUrl}/metrics`)).text();
const metricValue = async (series: string): Promise<number> => {
  const line = (await metricsText()).split('\n').find(text => text.startsWith(`${series} `));

  return line ? Number(line.slice(series.length + 1)) : 0;
};
const serviceInvalidations = () => metricValue('proxy_invalidation_events_total{kind="service"}');

/** Runs a change, then waits until the proxy has handled the invalidation events it published. */
const andInvalidated = async <TResult>(change: () => Promise<TResult>, events = 1): Promise<TResult> => {
  const before = await serviceInvalidations();
  const result = await change();
  await vi.waitFor(async () => expect(await serviceInvalidations()).toBeGreaterThanOrEqual(before + events));

  return result;
};

const upstreamRequests = () => upstream.requests.filter(request => !request.path.startsWith('/openapi.json'));

interface RawAnswer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

// node:http sends the path exactly as given: fetch would resolve dot segments before sending
const raw = async (path: string, method = 'GET'): Promise<RawAnswer> => new Promise((resolve, reject) => {
  const request = httpRequest({ host: '127.0.0.1', port: proxyPort, path, method }, response => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  request.on('error', reject);
  request.end();
});

const errorOf = async (response: Response) => ({ status: response.status, body: await response.json() as unknown });

// --- Tests ---

describe('forwarding to the upstream (PX-5, step 3)', () => {
  it('passes the method, the path with its target and the base URL prefix, the query, and the body; the upstream sees the seller\'s credential and x-request-id, and none of the client\'s Authorization, Cookie, or payment headers', async () => {
    const { id, secrets } = await createService();
    const body = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d, 0x00, 0xff]);
    const before = upstream.requests.length;

    const response = await fetch(`${proxyUrl}/service/${id}/echo?b=2&a=1&a=3&q=S%C3%A3o+Paulo`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sr_test_buyer-key',
        cookie: 'session=buyer',
        'x-payment': 'x402-payload',
        'payment-signature': 'signature',
        'content-type': 'application/octet-stream',
        accept: 'application/json',
        'idempotency-key': 'idem-1',
        'x-custom': 'dropped',
        'x-request-id': `forward-${id}`,
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe(`forward-${id}`);
    const [received] = upstream.requests.slice(before);
    expect(received).toMatchObject({ method: 'POST', path: '/v2/echo?b=2&a=1&a=3&q=S%C3%A3o+Paulo', servername: 'api.example.com' });
    expect(received!.body.equals(body)).toBe(true);
    expect(received!.headers).toMatchObject({
      authorization: `Bearer ${secrets.weather}`,
      'x-request-id': `forward-${id}`,
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      accept: 'application/json',
      'idempotency-key': 'idem-1',
    });
    for (const dropped of ['cookie', 'x-payment', 'payment-signature', 'x-custom'])
      expect(received!.headers).not.toHaveProperty(dropped);
  });

  it('rewrites the path to the route\'s target, keeping parameters percent-encoded', async () => {
    const { id } = await createService();
    const before = upstream.requests.length;

    const response = await fetch(`${proxyUrl}/service/${id}/forecast/S%C3%A3o%20Paulo`);

    expect(response.status).toBe(200);
    expect(upstream.requests.slice(before).map(request => request.path)).toEqual(['/v2/internal/forecast/S%C3%A3o%20Paulo']);
  });

  it('applies API keys in a header and the query, replacing the client\'s own query value', async () => {
    const { id, secrets } = await createService();
    const before = upstream.requests.length;

    const response = await fetch(`${proxyUrl}/service/${id}/upload?key=buyer-chosen&x=1`, { method: 'POST', body: 'file' });

    expect(response.status).toBe(201);
    const [received] = upstream.requests.slice(before);
    expect(received).toMatchObject({ servername: 'files.example.com', path: `/upload?x=1&key=${encodeURIComponent(secrets.query)}` });
    expect(received!.headers['x-api-key']).toBe(secrets.files);
    expect(received!.headers).not.toHaveProperty('authorization');
  });

  it('never fetches an OpenAPI document while serving, and serves with the Platform API stopped (PX-14, rule 1)', async () => {
    const separateApi = createApi({ config, logger, postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: apiHttp });
    const { port } = await separateApi.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
    const id = nextId();
    const created = await fetch(`http://127.0.0.1:${port}/v1/services/${id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${await signup()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ config: serviceYaml({ id }), secrets: { 'weather-key': 'w', 'files-key': 'f', 'files-query-key': 'q' } }),
    });
    expect(created.status).toBe(201);
    await separateApi.close();
    const fetches = upstream.requests.filter(request => request.path === '/openapi.json').length;

    const response = await fetch(`${proxyUrl}/service/${id}/weather/oslo`);

    expect(response.status).toBe(200);
    expect(upstream.requests.filter(request => request.path === '/openapi.json')).toHaveLength(fetches);
  });
});

describe('the response to the client (PX-6, PX-10, step 3)', () => {
  it('returns a redirect without following it (PX-2), rewrites Location, Content-Location, and Link that point at the upstream to the pay URL, and never passes Set-Cookie', async () => {
    const { id } = await createService();
    const before = upstreamRequests().length;

    const response = await fetch(`${proxyUrl}/service/${id}/redirect`, { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(upstreamRequests().slice(before).map(request => request.path)).toEqual(['/v2/redirect']);
    expect(response.headers.get('location')).toBe(`https://pay.staging.servicerouter.ai/service/${id}/weather/oslo`);
    // On the upstream but outside the service's base URL: dropped, so the upstream's paths don't leak
    expect(response.headers.has('content-location')).toBe(false);
    expect(response.headers.get('link')).toBe(`<https://pay.staging.servicerouter.ai/service/${id}/weather/bergen>; rel="alternate", <https://docs.example.net/weather>; rel="help"`);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has(headerMarker)).toBe(false);
  });

  it('passes the upstream\'s body and allowlisted headers only', async () => {
    const { id } = await createService();

    const response = await fetch(`${proxyUrl}/service/${id}/weather/oslo`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: 'GET', path: '/v2/weather/oslo', host: 'api.example.com' });
    expect(response.headers.get('content-type')).toBe('application/json');
    for (const dropped of ['set-cookie', 'server', headerMarker])
      expect(response.headers.has(dropped)).toBe(false);
  });

  it('passes any status of an operation that declares default', async () => {
    const { id } = await createService();

    const response = await fetch(`${proxyUrl}/service/${id}/anything`);

    expect([response.status, await response.text()]).toEqual([207, 'multi']);
  });
});

describe('matching (PX-4, PX-8, step 3)', () => {
  it.each([
    ['an unknown operation', 'GET', '/nothing/here'],
    ['a disabled route', 'POST', '/admin/reset'],
    ['a method the path doesn\'t declare', 'DELETE', '/weather/oslo'],
    ['HEAD on a GET operation, so a paid GET can\'t be reached for free', 'HEAD', '/weather/oslo'],
  ])('answers %s with 404 not_found, without calling the upstream', async (_case, method, path) => {
    const { id } = await createService();
    const before = upstream.requests.length;

    const response = await fetch(`${proxyUrl}/service/${id}${path}`, { method });

    expect(response.status).toBe(404);
    if (method !== 'HEAD')
      expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    expect(upstream.requests.length).toBe(before);
  });

  it('answers an unknown service with 404 not_found', async () => {
    const response = await fetch(`${proxyUrl}/service/no-such-service/weather/oslo`);

    expect(await errorOf(response)).toEqual({ status: 404, body: { error: { code: 'not_found', message: 'Not found' } } });
  });

  it('answers a suspended service with 403 service_suspended, and a pending one with 404 (SR-8)', async () => {
    const [suspended, pending] = [await createService(), await createService()];
    await database.db.update(services).set({ state: 'suspended' }).where(eq(services.id, suspended.id));
    await database.db.update(services).set({ state: 'pending' }).where(eq(services.id, pending.id));
    const before = upstream.requests.length;

    expect(await errorOf(await fetch(`${proxyUrl}/service/${suspended.id}/weather/oslo`)))
      .toEqual({ status: 403, body: { error: { code: 'service_suspended', message: 'The service is suspended' } } });
    expect((await fetch(`${proxyUrl}/service/${pending.id}/weather/oslo`)).status).toBe(404);
    expect(upstream.requests.length).toBe(before);
  });

  it('answers a body over 1 MiB with 413, without calling the upstream (PX-8)', async () => {
    const { id } = await createService();
    const before = upstream.requests.length;

    // Injected: over a socket, the 413 can race the upload and reach the client as a reset
    const response = await proxy.app.inject({ method: 'POST', url: `/service/${id}/echo`, payload: 'x'.repeat(config.sizeLimits.requestBodyBytes + 1) });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'request_too_large' } });
    expect(upstream.requests.length).toBe(before);
  });
});

describe('dot segments (PX-4, backlog)', () => {
  it.each([
    ['a raw dot-dot', '/weather/../admin/reset'],
    ['%2E%2E', '/weather/%2E%2E/admin/reset'],
    ['%2e.', '/weather/%2e./admin/reset'],
    ['a raw dot', '/./weather/oslo'],
    ['an encoded slash around a dot-dot, to escape the base URL\'s prefix', '/weather/%2E%2E%2F%2E%2E%2Fadmin'],
    ['a dot-dot as the first segment, to escape the base URL\'s prefix', '/%2e%2e/openapi.json'],
  ])('answers %s with 400 invalid_path, and the upstream records no request', async (_case, path) => {
    const { id } = await createService();
    const before = upstream.requests.length;

    const response = await raw(`/service/${id}${path}`);

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'invalid_path', message: 'The path must not hold "." or ".." segments, raw or encoded' } });
    expect(upstream.requests.length).toBe(before);
  });
});

describe('upstream failures (PX-7, step 3)', () => {
  it('answers a private address with 503 upstream_unavailable, and never connects to it (OH-1)', async () => {
    const { id } = await createService({ filesHost: 'private.example.com' });
    const before = upstream.connections;

    const response = await fetch(`${proxyUrl}/service/${id}/upload`, { method: 'POST', body: 'file' });

    expect(await errorOf(response)).toEqual({ status: 503, body: opaque503 });
    expect(resolver.lookups).toContain('private.example.com');
    expect(upstream.requests.filter(request => request.servername === 'private.example.com')).toEqual([]);
    expect(upstream.connections).toBe(before);
  });

  it('answers a timeout, a reset, and an undeclared status with the same opaque 503, carrying no upstream header or body', async () => {
    const { id } = await createService();

    const answers = await Promise.all(['slow', 'reset', 'teapot'].map(async path => {
      const response = await fetch(`${proxyUrl}/service/${id}/${path}`);
      const text = await response.text();

      return { status: response.status, text, headers: [...response.headers.keys()].filter(name => !['date', 'x-request-id'].includes(name)).sort() };
    }));

    for (const answer of answers) {
      expect(answer.status).toBe(503);
      expect(JSON.parse(answer.text)).toEqual(opaque503);
      expect(answer.text).not.toContain(bodyMarker);
      expect(answer.headers).not.toContain(headerMarker);
    }
    expect(new Set(answers.map(answer => JSON.stringify([answer.text, answer.headers]))).size).toBe(1);
    const reasons = await metricsText();
    for (const reason of ['outbound_timeout', 'connection_failed', 'undeclared_status'])
      expect(reasons).toContain(`proxy_upstream_errors_total{service="${id}",reason="${reason}"} 1`);
  });
});

describe('changes reach the proxy without a restart (SR-7, SC-7, step 3)', () => {
  it('serves a new revision on the next request', async () => {
    const { id } = await createService();
    expect((await fetch(`${proxyUrl}/service/${id}/admin/reset`, { method: 'POST' })).status).toBe(404);
    const before = upstreamRequests().length;

    await andInvalidated(() => apiCall('PUT', `/v1/services/${id}`, serviceYaml({ id, forecastTarget: '/v3/forecast/{city}', adminEnabled: true }), 'application/yaml'));

    expect((await fetch(`${proxyUrl}/service/${id}/admin/reset`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${proxyUrl}/service/${id}/forecast/oslo`)).status).toBe(200);
    expect(upstreamRequests().slice(before).map(request => request.path)).toEqual(['/v2/admin/reset', '/v2/v3/forecast/oslo']);
  });

  it('sends a rotated secret on the next request', async () => {
    const { id, secrets } = await createService();
    const before = upstream.requests.length;
    await fetch(`${proxyUrl}/service/${id}/weather/oslo`);
    const rotated = secretValue('rotated');

    await andInvalidated(() => apiCall('PUT', `/v1/services/${id}/secrets/weather-key`, JSON.stringify({ value: rotated })));
    await fetch(`${proxyUrl}/service/${id}/weather/oslo`);

    expect(upstream.requests.slice(before).map(request => request.headers.authorization)).toEqual([`Bearer ${secrets.weather}`, `Bearer ${rotated}`]);
  });

  it('drops the whole cache when the subscription comes back after a drop, so a change missed meanwhile is served next (backlog)', async () => {
    const { id } = await createService();
    expect((await fetch(`${proxyUrl}/service/${id}/admin/reset`, { method: 'POST' })).status).toBe(404);
    // A Platform API whose events are lost, as they are while the proxy's subscriber is disconnected
    const silentApi = createApi({
      config, logger, postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: apiHttp, invalidation: { publish: async () => undefined },
    });
    const { port } = await silentApi.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
    try {
      const changed = await fetch(`http://127.0.0.1:${port}/v1/services/${id}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${await signup()}`, 'content-type': 'application/yaml' },
        body: serviceYaml({ id, adminEnabled: true }),
      });
      expect(changed.status).toBe(200);
    }
    finally {
      await silentApi.close();
    }
    // The cached runtime still serves the old revision: the event never came
    expect((await fetch(`${proxyUrl}/service/${id}/admin/reset`, { method: 'POST' })).status).toBe(404);
    const reconnects = await metricValue('proxy_invalidation_reconnects_total');

    expect(await dropRedisConnections(redis, `${redis.prefix}invalidation`)).toBeGreaterThanOrEqual(1);
    await vi.waitFor(async () => expect(await metricValue('proxy_invalidation_reconnects_total')).toBe(reconnects + 1), { timeout: 5_000 });

    expect((await fetch(`${proxyUrl}/service/${id}/admin/reset`, { method: 'POST' })).status).toBe(200);
  });
});

describe('host binding in the proxy (SC-10, SC-5)', () => {
  it('never sends a secret to a host the revision moved its upstream to without resending it: 503, and no request anywhere', async () => {
    const { id } = await createService();
    expect((await fetch(`${proxyUrl}/service/${id}/upload`, { method: 'POST', body: 'file' })).status).toBe(201);
    // Written straight to the database, past the Platform API's checks, as a compromised API could
    const repository = createServiceRepository({ db: database.db });
    const active = (await repository.findRevision(id, 1))!;
    const config = structuredClone(active.config) as unknown as { upstreams: { baseUrl: string }[] };
    config.upstreams[1]!.baseUrl = upstream.url('moved.example.com', '');
    await repository.insertRevision({ ...active, number: 2, config: config as never });
    await andInvalidated(async () => {
      await repository.activate({ id, revision: 2, state: 'live', updatedAt: new Date() });
      await observer.publish({ kind: 'service', id });
    });
    const before = upstream.requests.length;

    const response = await fetch(`${proxyUrl}/service/${id}/upload`, { method: 'POST', body: 'file' });
    const weather = await fetch(`${proxyUrl}/service/${id}/weather/oslo`);

    expect(await errorOf(response)).toEqual({ status: 503, body: opaque503 });
    expect(weather.status).toBe(503);
    expect(upstream.requests.length).toBe(before);
    expect(logs).toContainEqual(expect.objectContaining({ serviceId: id, secretName: 'files-key', msg: 'A secret the service needs doesn\'t open' }));
  });

  it('opens with the runtime\'s origin, never the one stored on the row: a value sealed for another host gives 503', async () => {
    const { id } = await createService();
    // The row keeps the right origin in clear, but its value was sealed for another host
    await createServiceSecretRepository({ db: database.db }).put({
      serviceId: id,
      name: 'weather-key',
      origin: origin('api.example.com'),
      sealed: keys.sealer.seal({ serviceId: id, name: 'weather-key', origin: 'https://evil.example.net', value: Secret.from('sk-evil') }),
      updatedAt: new Date(),
    });
    const before = upstream.requests.length;

    const response = await fetch(`${proxyUrl}/service/${id}/weather/oslo`);

    expect(await errorOf(response)).toEqual({ status: 503, body: opaque503 });
    expect(upstream.requests.length).toBe(before);
  });

  it('answers 503 when a secret the runtime needs is missing, and never forwards without it', async () => {
    const id = nextId();
    await apiCall('PUT', `/v1/services/${id}`, serviceYaml({ id }), 'application/yaml');
    const before = upstream.requests.length;

    const response = await fetch(`${proxyUrl}/service/${id}/weather/oslo`);

    expect(await errorOf(response)).toEqual({ status: 503, body: opaque503 });
    expect(upstream.requests.length).toBe(before);
    expect(logs).toContainEqual(expect.objectContaining({ serviceId: id, secretName: 'weather-key', msg: 'A secret the service needs is not set' }));
  });

  it('never logs a secret value', async () => {
    const { id, secrets } = await createService();
    await fetch(`${proxyUrl}/service/${id}/weather/oslo`);
    await fetch(`${proxyUrl}/service/${id}/upload`, { method: 'POST', body: 'file' });

    const shown = JSON.stringify(logs);
    for (const value of Object.values(secrets))
      expect(shown).not.toContain(value);
  });
});

describe('dispatch (PX-1)', () => {
  it.each([
    ['no segment, the link checker later', '/', 404],
    ['service without an ID', '/service', 404],
    ['an unknown platform path', '/_/nothing', 404],
    ['.well-known', '/.well-known/servicerouter.json', 404],
    ['a hostname, payment routing later', '/api.example.com/v1/x', 404],
    ['anything else', '/v1/services', 400],
  ])('answers %s with %i', async (_case, path, status) => {
    const before = upstream.requests.length;

    const response = await fetch(`${proxyUrl}${path}`);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(status === 400
      ? { error: { code: 'invalid_target', message: 'The path must start with /service/<service-id>/' } }
      : { error: { code: 'not_found', message: 'Not found' } });
    expect(upstream.requests.length).toBe(before);
  });
});

describe('response headers on every answer (PX-9, PX-16)', () => {
  it('sends Content-Security-Policy: sandbox, nosniff, and the CORS headers on proxied answers, errors, and platform paths', async () => {
    const { id } = await createService();
    const responses = await Promise.all([
      fetch(`${proxyUrl}/service/${id}/weather/oslo`),
      fetch(`${proxyUrl}/service/${id}/redirect`, { redirect: 'manual' }),
      fetch(`${proxyUrl}/service/${id}/nothing`),
      fetch(`${proxyUrl}/service/${id}/teapot`),
      fetch(`${proxyUrl}/v1/x`),
      fetch(`${proxyUrl}/_/health`),
    ]);

    expect(responses.map(response => response.status)).toEqual([200, 302, 404, 503, 400, 200]);
    for (const response of responses) {
      expect(response.headers.get('content-security-policy')).toBe('sandbox');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-expose-headers'))
        .toBe('PAYMENT-REQUIRED, PAYMENT-RESPONSE, WWW-Authenticate, Payment-Receipt, Servicerouter-Receipt, x-request-id');
    }
  });

  it('answers a CORS preflight itself, allowing the payment and auth headers, without calling the upstream', async () => {
    const { id } = await createService();
    const before = upstream.requests.length;

    const response = await fetch(`${proxyUrl}/service/${id}/echo`, {
      method: 'OPTIONS',
      headers: { origin: 'https://agent.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, x-payment' },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toBe('Authorization, PAYMENT-SIGNATURE, X-PAYMENT, Content-Type');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response.headers.get('content-security-policy')).toBe('sandbox');
    expect(upstream.requests.length).toBe(before);
  });
});

describe('metrics (XC-2)', () => {
  it('counts upstream latency by service and status, cache hits and misses, and invalidation events', async () => {
    const { id } = await createService();
    await fetch(`${proxyUrl}/service/${id}/weather/oslo`);
    await fetch(`${proxyUrl}/service/${id}/weather/oslo`);

    const text = await metricsText();

    expect(text).toContain(`proxy_upstream_request_duration_seconds_count{service="${id}",status="200"} 2`);
    expect(await metricValue('proxy_runtime_cache_lookups_total{result="hit"}')).toBeGreaterThan(0);
    expect(await metricValue('proxy_runtime_cache_lookups_total{result="miss"}')).toBeGreaterThan(0);
    expect(await serviceInvalidations()).toBeGreaterThan(0);
    expect(text).toContain('http_requests_total{method="GET",route="/service/*",status="200"}');
  });
});
