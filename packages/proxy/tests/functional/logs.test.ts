import { createServer as createNetServer, type AddressInfo } from 'node:net';

import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp as createApi, type ApiServer } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp, Secret, type ServiceId } from '@servicerouter/common';
import { assumeHostsVerified, loadPlatformConfig, type PlatformConfig } from '@servicerouter/core';
import { createFacilitators, initializeX402, type X402Setup } from '@servicerouter/payments';
import {
  createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, encodeBase58, facilitatorAnswers, startFakeFacilitator,
  startFakeUpstream, type FakeFacilitator, type FakeUpstream, type TestDatabase, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createApp, type ProxyServer } from '../../src/app.js';

// Diagnostic logs of paid calls (T24): what failed, where, and why, with no secret on any line

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const buyerHeaderKey = 'buyer-header-key-for-the-logs-tests-000';
const internalSecret = 'internal-secret-for-the-logs-tests-0123456789';
const weatherSecret = 'sk-weather-bearer-secret-0123456789';
const querySecret = 'sk-weather-query-secret-0123456789';
const generous = { requests: 100_000, windowSeconds: 60 };
const clock = { now: () => new Date() };

const openapi = {
  openapi: '3.1.0',
  info: { title: 'Weather', version: '1.0.0' },
  paths: {
    '/weather/{city}': { get: { operationId: 'getWeather', summary: 'Current weather', responses: { 200: { description: 'OK' } } } },
    '/broken': { get: { operationId: 'getBroken', responses: { 200: { description: 'OK' }, 500: { description: 'Error' } } } },
  },
};

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let keys: TestSecretKeys;
let upstream: FakeUpstream;
let facilitator: FakeFacilitator;
let setup: X402Setup;
let apiHttp: OutboundHttp;
let proxyHttp: OutboundHttp;
let api: ApiServer;
let proxy: ProxyServer;
let apiUrl: string;
let internalUrl: string;
let proxyUrl: string;
let downPort: number;
let seller: { readonly id: string; readonly masterKey: string };
const serviceId = 'logs-weather' as ServiceId;
// Every line the proxy writes, debug included
const lines: Record<string, unknown>[] = [];
let upstreamIds = 0;

// A port nothing listens on: the down upstream refuses every connection
const closedPort = async (): Promise<number> => {
  const server = createNetServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise(resolve => server.close(resolve));

  return port;
};

const serviceYaml = () => `servicerouter:
  version: "1"

service:
  id: ${serviceId}
  title: Weather
  description: Weather forecasts.
  category: weather

payouts:
  default:
    asset: cardano-usdm
    address: addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5

payments:
  default:
    amount: "0.001"

upstreams:
  - baseUrl: ${upstream.url('api.example.com', '/v2')}
    name: main
    openapi: ${upstream.url('api.example.com', '/openapi.json')}
    auth: [main-key, main-query]

  - baseUrl: https://down.example.com:${downPort}
    name: down
    paths:
      /status:
        get:
          operationId: getStatus
          responses: { "200": { description: OK } }

credentials:
  main-key:
    type: http
    scheme: bearer
    secret: weather-key
  main-query:
    type: apiKey
    in: query
    name: key
    secret: weather-query
`;

beforeAll(async () => {
  [database, redis, keys, upstream, facilitator, downPort] = await Promise.all([
    createTestDatabase(),
    createTestRedis(),
    createTestSecretKeys(),
    startFakeUpstream({ hosts: ['api.example.com', 'down.example.com'] }),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }),
    closedPort(),
  ]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        rateLimits: { signup: generous, paymentKey: generous, service: generous, unpaidIp: generous },
        facilitators: [
          { name: 'cdp', url: facilitator.url, networks: [base, solana] },
          { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:preprod'], enabled: false },
        ],
        mpp: { enabled: false },
      })).toString('base64'),
    },
  });
  upstream.handle((request, response) => {
    const path = request.path.split('?')[0]!;
    upstreamIds += 1;
    // The upstream names its own request, as many do (L-2)
    response.setHeader('x-request-id', `upstream-${upstreamIds}`);
    if (path === '/openapi.json')
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(openapi));
    else if (path === '/v2/broken')
      response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"upstream body secret"}');
    else
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ weather: 'sunny', note: 'upstream body secret' }));
  });
  const resolver = createFakeResolver({ 'api.example.com': '127.0.0.1', 'down.example.com': '127.0.0.1' });
  const outbound = { ownHosts: config.ownHosts, resolver, addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }), ca: upstream.ca };
  apiHttp = new OutboundHttp({ ...outbound, connectTimeoutMs: 5_000 });
  proxyHttp = new OutboundHttp({ ...outbound, connectTimeoutMs: 5_000, totalTimeoutMs: 5_000 });
  setup = await initializeX402({ config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth here'); }, clock }), timeoutMs: 5_000 });

  api = createApi({
    config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: apiHttp,
    ownership: assumeHostsVerified, internalSecret: Secret.from(internalSecret),
  });
  const logger = createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  proxy = createApp({ config, logger, postgres: database.postgres, redis, opener: keys.opener, http: proxyHttp, buyerHeaderKey: Secret.from(buyerHeaderKey), x402: setup });
  const [apiPorts, proxyPorts] = await Promise.all([
    api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 }),
    proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 }),
  ]);
  apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  internalUrl = `http://127.0.0.1:${apiPorts.internalPort!}`;
  proxyUrl = `http://127.0.0.1:${proxyPorts.port}`;
  await proxy.subscribed;

  seller = await (await fetch(`${apiUrl}/v1/accounts`, { method: 'POST' })).json() as { id: string; masterKey: string };
  const submitted = await fetch(`${apiUrl}/v1/services/${serviceId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${seller.masterKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ config: serviceYaml(), secrets: { 'weather-key': weatherSecret, 'weather-query': querySecret } }),
  });
  if (submitted.status >= 300)
    throw new Error(`Submit failed: ${await submitted.text()}`);
});

afterAll(async () => {
  await Promise.all([api?.close(), proxy?.close()]);
  await Promise.all([apiHttp?.close(), proxyHttp?.close(), upstream?.close(), facilitator?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

beforeEach(() => {
  facilitator.reset();
});

// --- Helpers ---

let counter = 0;
const nextRequestId = (label: string) => {
  counter += 1;

  return `${label}-${counter}`;
};

/** A buyer with $1 of credits and a payment key. */
const creditsBuyer = async () => {
  const account = await (await fetch(`${apiUrl}/v1/accounts`, { method: 'POST' })).json() as { id: string; masterKey: string };
  const { key } = await (await fetch(`${apiUrl}/v1/keys`, {
    method: 'POST', headers: { authorization: `Bearer ${account.masterKey}`, 'content-type': 'application/json' }, body: '{}',
  })).json() as { key: string };
  await fetch(`${internalUrl}/internal/v1/accounts/${account.id}/credits`, {
    method: 'POST', headers: { 'x-internal-secret': internalSecret, 'content-type': 'application/json' }, body: JSON.stringify({ amount: '1', reference: `credit-${account.id}` }),
  });

  return { ...account, key };
};

const wallet = privateKeyToAccount(generatePrivateKey());

/** A PAYMENT-SIGNATURE on Base, signed by the official x402 client for the 402's option. */
const x402Signature = async (path: string): Promise<string> => {
  const challenge = await fetch(`${proxyUrl}/service/${serviceId}${path}`);
  const required = decodePaymentRequiredHeader(challenge.headers.get('payment-required')!);
  const client = new x402Client().register(base, new ExactEvmScheme(wallet));

  return encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === base) }));
};

const call = async (path: string, headers: Record<string, string>, label: string) => {
  const requestId = nextRequestId(label);
  const response = await fetch(`${proxyUrl}/service/${serviceId}${path}`, { headers: { ...headers, 'x-request-id': requestId } });
  await response.text();

  return { response, requestId };
};

const linesOf = (requestId: string) => lines.filter(line => line['requestId'] === requestId);

/** The request's line with this message, once it is written: credits finish after the response closes. */
const lineOf = async (requestId: string, msg: string): Promise<Record<string, unknown>> => {
  await expect.poll(() => linesOf(requestId).some(line => line['msg'] === msg)).toBe(true);

  return linesOf(requestId).find(line => line['msg'] === msg)!;
};

// --- Tests ---

describe('a paid call\'s outcome line (L-3)', () => {
  it('logs a credits call once, with its payment, the decision, the final status, and the time spent verifying, upstream, and settling', async () => {
    const buyer = await creditsBuyer();

    const { response, requestId } = await call('/weather/oslo', { authorization: `Bearer ${buyer.key}` }, 'credits');

    expect(response.status).toBe(200);
    expect(await lineOf(requestId, 'Paid call finished')).toMatchObject({
      level: 30,
      paymentId: expect.stringMatching(/^pay_/),
      rail: 'credits',
      amount: '0.001',
      serviceId,
      routeKey: 'getWeather',
      decision: 'billable',
      paymentStatus: 'captured',
      verifyMs: expect.any(Number),
      upstreamMs: expect.any(Number),
      settleMs: expect.any(Number),
      upstreamStatus: 200,
      // L-2: the upstream's own request ID
      upstreamRequestId: expect.stringMatching(/^upstream-\d+$/),
    });
    expect(linesOf(requestId).filter(line => line['msg'] === 'Paid call finished')).toHaveLength(1);
  });

  it('logs an x402 call with its network, asset, and the settlement\'s transaction', async () => {
    const signature = await x402Signature('/weather/bergen');

    const { response, requestId } = await call('/weather/bergen', { 'payment-signature': signature }, 'x402');

    expect(response.status).toBe(200);
    expect(await lineOf(requestId, 'Paid call finished')).toMatchObject({
      level: 30, rail: 'x402', network: base, asset: 'base-usdc', amount: '0.001', decision: 'billable', paymentStatus: 'settled',
      transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/), upstreamStatus: 200,
    });
  });
});

describe('a paid call that fails logs the stage and the reason (L-3, L-4, acceptance check 2)', () => {
  it('verify refused: the buyer\'s fault, at info, with the code and the facilitator\'s reason', async () => {
    facilitator.handle('/verify', facilitatorAnswers.invalid('invalid_exact_evm_signature'));
    const signature = await x402Signature('/weather/oslo');

    const { response, requestId } = await call('/weather/oslo', { 'payment-signature': signature }, 'refused');

    expect(response.status).toBe(402);
    expect(await lineOf(requestId, 'Paid call refused')).toMatchObject({
      level: 30, rail: 'x402', paymentId: expect.stringMatching(/^pay_/), code: 'payment_invalid', reason: 'invalid_exact_evm_signature', facilitator: 'cdp',
    });
    expect(await lineOf(requestId, 'Request completed')).toMatchObject({ level: 30, status: 402, code: 'payment_invalid' });
  });

  it('a refused hold: at info, with its code', async () => {
    // No credits
    const broke = await (await fetch(`${apiUrl}/v1/accounts`, { method: 'POST' })).json() as { masterKey: string };
    const { key } = await (await fetch(`${apiUrl}/v1/keys`, {
      method: 'POST', headers: { authorization: `Bearer ${broke.masterKey}`, 'content-type': 'application/json' }, body: '{}',
    })).json() as { key: string };

    const { response, requestId } = await call('/weather/oslo', { authorization: `Bearer ${key}` }, 'broke');

    expect(response.status).toBe(402);
    expect(await lineOf(requestId, 'Paid call refused')).toMatchObject({ level: 30, rail: 'credits', code: 'insufficient_balance' });
  });

  it('a facilitator down at verify: the platform\'s fault, at warn, with its name, network, path, and status', async () => {
    facilitator.handle('/verify', facilitatorAnswers.unavailable);
    const signature = await x402Signature('/weather/oslo');

    const { response, requestId } = await call('/weather/oslo', { 'payment-signature': signature }, 'facilitator-down');

    expect(response.status).toBe(503);
    expect(await lineOf(requestId, 'Paid call refused: the payment couldn\'t be checked')).toMatchObject({
      level: 40, rail: 'x402', code: 'facilitator_unavailable',
      error: { code: 'facilitator_unavailable', facilitator: 'cdp', network: base, method: 'POST', path: '/verify', status: 503, durationMs: expect.any(Number) },
    });
  });

  it('upstream down: the connection\'s error code, the host, method, path without its query, and duration; then the payment released', async () => {
    const buyer = await creditsBuyer();

    const { response, requestId } = await call('/status?city=oslo&key=buyer-query', { authorization: `Bearer ${buyer.key}` }, 'down');

    expect(response.status).toBe(503);
    expect(await lineOf(requestId, 'The upstream call failed')).toMatchObject({
      level: 40, serviceId, host: `down.example.com:${downPort}`, method: 'GET', path: '/status', code: 'ECONNREFUSED', durationMs: expect.any(Number),
      error: { code: 'connection_failed' },
    });
    expect(await lineOf(requestId, 'Paid call finished')).toMatchObject({
      level: 30, rail: 'credits', decision: 'not_billable', paymentStatus: 'released', upstreamStatus: null,
    });
    expect(JSON.stringify(linesOf(requestId))).not.toContain('buyer-query');
  });

  it('an upstream answering 5xx: an expected outcome, at info, with its status and its own request ID', async () => {
    const buyer = await creditsBuyer();

    const { response, requestId } = await call('/broken', { authorization: `Bearer ${buyer.key}` }, 'broken');

    expect(response.status).toBe(500);
    expect(await lineOf(requestId, 'The upstream answered with a server error')).toMatchObject({
      level: 30, serviceId, host: expect.stringMatching(/^api\.example\.com:\d+$/), method: 'GET', path: '/v2/broken', status: 500,
      upstreamRequestId: expect.stringMatching(/^upstream-\d+$/),
    });
    expect(await lineOf(requestId, 'Paid call finished')).toMatchObject({ decision: 'not_billable', paymentStatus: 'released', upstreamStatus: 500 });
  });

  it('settle failed: at warn, with the facilitator\'s errorReason', async () => {
    facilitator.handle('/settle', facilitatorAnswers.failed('insufficient_funds'));
    const signature = await x402Signature('/weather/narvik');

    const { response, requestId } = await call('/weather/narvik', { 'payment-signature': signature }, 'settle-failed');

    expect(response.status).toBe(502);
    expect(await lineOf(requestId, 'Paid call failed to settle')).toMatchObject({
      level: 40, rail: 'x402', network: base, decision: 'billable', paymentStatus: 'failed', outcome: 'failed', reason: 'insufficient_funds', facilitator: 'cdp',
    });
    expect(await lineOf(requestId, 'The settlement failed. Nothing was charged.')).toMatchObject({ reason: 'insufficient_funds', facilitator: 'cdp', network: base });
  });

  it('settle pending: at warn, with settlement_pending and the transaction hash', async () => {
    facilitator.handle('/settle', facilitatorAnswers.pending('0xpending0042'));
    const signature = await x402Signature('/weather/bodo');

    const { response, requestId } = await call('/weather/bodo', { 'payment-signature': signature }, 'settle-pending');

    expect(response.status).toBe(200);
    expect(await lineOf(requestId, 'Paid call finished: its settlement is pending')).toMatchObject({
      level: 40, rail: 'x402', paymentStatus: 'settling', reason: 'settlement_pending', transaction: '0xpending0042',
    });
  });

  it('settle unknown, the facilitator down: at warn, with its status, and the rail\'s line with the facilitator\'s fields', async () => {
    facilitator.handle('/settle', facilitatorAnswers.unavailable);
    const signature = await x402Signature('/weather/tromso');

    const { response, requestId } = await call('/weather/tromso', { 'payment-signature': signature }, 'settle-unknown');

    expect(response.status).toBe(502);
    expect(await lineOf(requestId, 'Paid call failed to settle')).toMatchObject({
      level: 40, paymentStatus: 'settling', outcome: 'unknown', reason: '/settle answered 503', facilitator: 'cdp',
    });
    expect(await lineOf(requestId, 'The settlement\'s outcome is unknown. The settlement follow-up repeats it.')).toMatchObject({
      facilitator: 'cdp', network: base, error: { code: 'facilitator_unavailable', path: '/settle', status: 503 },
    });
  });
});

describe('the proxy\'s lines carry no secret (XC-7, CK-3, rule 10)', () => {
  it('logs credits, x402, and unpaid calls without a key, a signature, a seller secret, a body, or a query', async () => {
    const buyer = await creditsBuyer();
    const signature = await x402Signature('/weather/secret-city');
    const before = lines.length;

    await call('/weather/secret-city?key=buyer-query-secret', { authorization: `Bearer ${buyer.key}` }, 'secrets');
    await call('/weather/secret-city', { 'payment-signature': signature }, 'secrets');
    await call('/weather/secret-city', {}, 'secrets');
    await call('/broken', { authorization: `Bearer ${buyer.key}`, cookie: 'session=cookie-secret' }, 'secrets');
    await expect.poll(() => lines.slice(before).filter(line => line['msg'] === 'Paid call finished').length).toBeGreaterThanOrEqual(3);

    const logged = JSON.stringify(lines);
    for (const secret of [
      buyer.key, buyer.masterKey, seller.masterKey, signature, weatherSecret, querySecret, buyerHeaderKey, internalSecret, 'buyer-query-secret',
      'cookie-secret', 'upstream body secret', 'Bearer ',
    ])
      expect(logged).not.toContain(secret);
  });
});
