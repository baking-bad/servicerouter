import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { extractDiscoveryInfo, validateDiscoveryExtension, type DiscoveryExtension } from '@x402/extensions/bazaar';
import { and, eq, sql } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp as createApi, type ApiServer } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp, Secret, type ServiceId } from '@servicerouter/common';
import { assumeHostsVerified, loadPlatformConfig, type BazaarMetadata, type PlatformConfig } from '@servicerouter/core';
import { serviceDocuments } from '@servicerouter/db';
import { bazaarExtensionKey, createFacilitators, initializeX402 } from '@servicerouter/payments';
import {
  createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, encodeBase58, startFakeFacilitator, startFakeUpstream,
  type FakeFacilitator, type FakeUpstream, type TestDatabase, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createApp, type ProxyServer } from '../../src/app.js';

// PR-7, AD-3, P-4: a registered service's x402 challenge lists its operation in the Bazaar, unless the
// seller sets `service.discoverable: false`.

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const generous = { requests: 100_000, windowSeconds: 60 };
const clock = { now: () => new Date() };
const serviceId = 'bazaar-weather' as ServiceId;

const openapi = {
  openapi: '3.1.0',
  info: { title: 'Weather', version: '1.0.0' },
  paths: {
    '/weather/{city}': {
      get: {
        operationId: 'getWeather',
        summary: 'Current weather',
        description: 'Current weather for a city, in metric or imperial units',
        parameters: [
          { name: 'city', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'units', in: 'query', required: true, schema: { type: 'string', enum: ['metric', 'imperial'] } },
        ],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { city: { type: 'string' }, celsius: { type: 'number' } }, required: ['city'] },
                example: { city: 'Oslo', celsius: 4 },
              },
            },
          },
        },
      },
    },
  },
};

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let keys: TestSecretKeys;
let upstream: FakeUpstream;
let facilitator: FakeFacilitator;
let apiHttp: OutboundHttp;
let proxyHttp: OutboundHttp;
let api: ApiServer;
let proxy: ProxyServer;
let apiUrl: string;
let proxyUrl: string;
let seller: { readonly id: string; readonly masterKey: string };

const serviceYaml = (discoverable?: boolean) => `servicerouter:
  version: "1"

service:
  id: ${serviceId}
  title: Weather
  description: Weather forecasts.
  category: weather
${discoverable === undefined ? '' : `  discoverable: ${discoverable}\n`}
payouts:
  default:
    asset: cardano-usdm
    address: addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5

payments:
  default:
    amount: "0.001"

upstreams:
  - baseUrl: ${upstream.url('api.example.com', '/v2')}
    openapi: ${upstream.url('api.example.com', '/openapi.json')}
    auth: main-key

credentials:
  main-key:
    type: http
    scheme: bearer
    secret: weather-key
`;

const submit = async (discoverable?: boolean): Promise<{ readonly status: number; readonly body: { revision: number; changed: boolean } }> => {
  const response = await fetch(`${apiUrl}/v1/services/${serviceId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${seller.masterKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ config: serviceYaml(discoverable), secrets: { 'weather-key': 'sk-weather' } }),
  });

  return { status: response.status, body: await response.json() as { revision: number; changed: boolean } };
};

beforeAll(async () => {
  [database, redis, keys, upstream, facilitator] = await Promise.all([
    createTestDatabase(),
    createTestRedis(),
    createTestSecretKeys(),
    startFakeUpstream({ hosts: ['api.example.com'] }),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }),
  ]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        rateLimits: { signup: generous, paymentKey: generous, service: generous, unpaidIp: generous, documents: generous },
        facilitators: [
          { name: 'cdp', url: facilitator.url, networks: [base, solana] },
          { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:preprod'], enabled: false },
        ],
        mpp: { enabled: false },
      })).toString('base64'),
    },
  });
  upstream.handle((request, response) => {
    if (request.path.split('?')[0] === '/openapi.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(openapi));
    }
    else
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ city: 'Oslo', celsius: 4 }));
  });
  const resolver = createFakeResolver({ 'api.example.com': '127.0.0.1' });
  const outbound = { ownHosts: config.ownHosts, resolver, addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }), ca: upstream.ca };
  apiHttp = new OutboundHttp({ ...outbound, connectTimeoutMs: 5_000 });
  proxyHttp = new OutboundHttp({
    ...outbound, connectTimeoutMs: 5_000, totalTimeoutMs: 5_000, maxRequestBytes: config.sizeLimits.requestBodyBytes, maxResponseBytes: 1_048_576,
  });
  const x402 = await initializeX402({ config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth here'); }, clock }), timeoutMs: 5_000 });

  const logger = createLogger({ level: 'silent' });
  api = createApi({ config, logger, postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: apiHttp, ownership: assumeHostsVerified, internalSecret: Secret.from('internal-secret-0123456789abcdef-xyz') });
  proxy = createApp({ config, logger, postgres: database.postgres, redis, opener: keys.opener, http: proxyHttp, buyerHeaderKey: Secret.from('buyer-header-key-for-the-bazaar-tests'), x402 });
  const [apiPorts, proxyPorts] = await Promise.all([
    api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 }),
    proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 }),
  ]);
  apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  proxyUrl = `http://127.0.0.1:${proxyPorts.port}`;
  await proxy.subscribed;

  seller = await (await fetch(`${apiUrl}/v1/accounts`, { method: 'POST' })).json() as { id: string; masterKey: string };
  const submitted = await submit();
  if (submitted.status !== 201)
    throw new Error(`Submit failed: ${JSON.stringify(submitted.body)}`);
});

afterAll(async () => {
  await Promise.all([api?.close(), proxy?.close()]);
  await Promise.all([apiHttp?.close(), proxyHttp?.close(), upstream?.close(), facilitator?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

beforeEach(() => {
  facilitator.reset();
});

const challenge = async (path = '/weather/oslo?units=metric'): Promise<PaymentRequired> => {
  const response = await fetch(`${proxyUrl}/service/${serviceId}${path}`);
  expect(response.status).toBe(402);

  return decodePaymentRequiredHeader(response.headers.get('payment-required')!);
};

const bazaarOf = (required: PaymentRequired) => required.extensions?.[bazaarExtensionKey] as (DiscoveryExtension & { routeTemplate?: string }) | undefined;

/** The active revision's `bazaar.json`, as the API stores it with the documents (AD-3). */
const storedBazaar = async (revision: number): Promise<{ readonly operations: readonly BazaarMetadata[] }> => {
  expect((await fetch(`${apiUrl}/v1/services/${serviceId}/openapi.json`)).status).toBe(200);
  const [row] = await database.db.select().from(serviceDocuments)
    .where(and(eq(serviceDocuments.serviceId, serviceId), eq(serviceDocuments.revision, revision), eq(serviceDocuments.kind, 'bazaar.json')));

  return JSON.parse(row!.content) as { readonly operations: readonly BazaarMetadata[] };
};

describe('the x402 Bazaar listing (PR-7, AD-3, P-4)', () => {
  it('carries the operation\'s description, input and output schemas, and example from its revision\'s bazaar.json', async () => {
    const [entry] = (await storedBazaar(1)).operations;

    const required = await challenge();
    const bazaar = bazaarOf(required)!;

    expect(entry).toMatchObject({ resource: `${config.urls.pay}/service/${serviceId}/weather/{city}`, method: 'GET' });
    expect(required.resource).toEqual({ url: `${config.urls.pay}/service/${serviceId}/weather/oslo`, description: entry!.description, mimeType: entry!.output!.contentType });
    expect(entry!.description).toBe('Current weather for a city, in metric or imperial units');
    expect(bazaar.routeTemplate).toBe(`/service/${serviceId}/weather/:city`);
    expect(bazaar.info).toEqual({
      input: { type: 'http', method: 'GET', queryParams: { units: 'metric' }, pathParams: { city: 'oslo' } },
      output: { type: 'json', example: entry!.example },
    });
    const schema = bazaar.schema.properties as Record<string, { properties: Record<string, unknown> }>;
    expect(schema['input']!.properties['queryParams']).toEqual({ type: 'object', properties: { units: entry!.input.parameters[1]!.schema }, required: ['units'] });
    expect(schema['output']!.properties['example']).toEqual(entry!.output!.schema);
    expect(validateDiscoveryExtension(bazaar)).toEqual({ valid: true });
  });

  it('verifies and settles a paid call that echoes the extension, which reaches the facilitator as a listing under the route template', async () => {
    const required = await challenge('/weather/bergen?units=metric');
    const client = new x402Client().register(base, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
    const signature = encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === base) }));

    const response = await fetch(`${proxyUrl}/service/${serviceId}/weather/bergen?units=metric`, { headers: { 'payment-signature': signature, 'x-request-id': 'bazaar-paid' } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ city: 'Oslo', celsius: 4 });
    expect(response.headers.get('payment-response')).not.toBeNull();
    const { rows } = await database.db.execute<{ status: string }>(sql`select status from payments where request_id = 'bazaar-paid'`);
    expect(rows[0]?.status).toBe('settled');
    const calls = facilitator.requests.filter(request => request.path === '/verify' || request.path === '/settle');
    expect(calls.map(call => call.path)).toEqual(['/verify', '/settle']);
    for (const call of calls) {
      const body = call.body as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
      expect(body.paymentPayload.extensions?.[bazaarExtensionKey]).toEqual(bazaarOf(required));
      expect(extractDiscoveryInfo(body.paymentPayload, body.paymentRequirements)).toMatchObject({
        resourceUrl: `${config.urls.pay}/service/${serviceId}/weather/:city`, method: 'GET', description: 'Current weather for a city, in metric or imperial units',
      });
    }
  });

  it('keeps a service with discoverable: false out of the Bazaar; toggling it makes a new revision each time', async () => {
    const optedOut = await submit(false);

    expect(optedOut).toMatchObject({ status: 200, body: { revision: 2, changed: true } });
    // The proxy reloads the service when the activation is published (SR-7)
    await vi.waitFor(async () => expect(bazaarOf(await challenge())).toBeUndefined());
    const unlisted = await challenge();
    expect(unlisted.extensions).toBeUndefined();
    expect(unlisted.resource).toEqual({ url: `${config.urls.pay}/service/${serviceId}/weather/oslo`, description: 'Current weather' });
    // The documents still store the revision's metadata, unchanged
    expect((await storedBazaar(2)).operations).toEqual((await storedBazaar(1)).operations);

    const listedAgain = await submit(true);

    expect(listedAgain).toMatchObject({ status: 200, body: { revision: 3, changed: true } });
    await vi.waitFor(async () => expect(bazaarOf(await challenge())).toBeDefined());
    expect(await submit(true)).toMatchObject({ status: 200, body: { revision: 3, changed: false } });
  });
});
