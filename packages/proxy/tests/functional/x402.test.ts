import { generateKeyPairSigner } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { sql } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp as createApi, type ApiServer } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp, Secret, type ServiceId } from '@servicerouter/common';
import { assumeHostsVerified, loadPlatformConfig, type Payment, type PlatformConfig } from '@servicerouter/core';
import { createLedger, createPaymentRepository } from '@servicerouter/db';
import { createAssetLookup, createFacilitatorLookup, createFacilitators, initializeX402, type X402Setup } from '@servicerouter/payments';
import {
  createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, encodeBase58, facilitatorAnswers, startFakeFacilitator,
  startFakeSolanaRpc, startFakeUpstream, type FakeFacilitator, type FakeSolanaRpc, type FakeUpstream, type TestDatabase, type TestRedis,
  type TestSecretKeys,
} from '@servicerouter/testing';
import { createSettlementFollowUp } from '@servicerouter/workers';

import { createApp, type ProxyServer } from '../../src/app.js';
import { createBuyerHeaderValue } from '../../src/payments/buyer.js';

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const buyerHeaderKey = 'buyer-header-key-for-the-x402-tests-000';
const generous = { requests: 100_000, windowSeconds: 60 };
const bufferLimit = 4_096;
const settleTimeoutMs = 400;
const clock = { now: () => new Date() };

const openapi = {
  openapi: '3.1.0',
  info: { title: 'Weather', version: '1.0.0' },
  paths: {
    '/weather/{city}': { get: { operationId: 'getWeather', summary: 'Current weather', responses: { 200: { description: 'OK' } } } },
    '/broken': { get: { operationId: 'getBroken', responses: { 200: { description: 'OK' }, 500: { description: 'Error' } } } },
    '/teapot': { get: { operationId: 'getTeapot', responses: { 200: { description: 'OK' } } } },
    '/big': { get: { operationId: 'getBig', responses: { 200: { description: 'OK' } } } },
  },
};

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let keys: TestSecretKeys;
let upstream: FakeUpstream;
let facilitator: FakeFacilitator;
let rpc: FakeSolanaRpc;
let setup: X402Setup;
let apiHttp: OutboundHttp;
let proxyHttp: OutboundHttp;
let api: ApiServer;
let proxy: ProxyServer;
let apiUrl: string;
let proxyUrl: string;
let seller: { readonly id: string; readonly masterKey: string };
let serviceId: ServiceId;

beforeAll(async () => {
  [database, redis, keys, upstream, facilitator, rpc] = await Promise.all([
    createTestDatabase(),
    createTestRedis(),
    createTestSecretKeys(),
    startFakeUpstream({ hosts: ['api.example.com'] }),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }),
    startFakeSolanaRpc(),
  ]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        feeBps: 250,
        rateLimits: { signup: generous, paymentKey: generous, service: generous, unpaidIp: generous },
        timeouts: { settleMs: settleTimeoutMs },
        sizeLimits: { bufferedResponseBytes: bufferLimit },
        facilitators: [
          { name: 'cdp', url: facilitator.url, networks: [base, solana] },
          { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:preprod'], enabled: false },
        ],
      })).toString('base64'),
    },
  });
  upstream.handle((request, response) => {
    const path = request.path.split('?')[0]!;
    if (path === '/openapi.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(openapi));
    }
    else if (path === '/v2/broken')
      response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
    else if (path === '/v2/teapot')
      response.writeHead(418).end('teapot');
    else if (path === '/v2/big')
      response.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(bufferLimit * 2));
    else {
      response.writeHead(200, { 'content-type': 'application/json', etag: '"weather-1"' });
      response.end(JSON.stringify({ path: request.path, buyer: request.headers['servicerouter-buyer'] ?? null }));
    }
  });
  const resolver = createFakeResolver({ 'api.example.com': '127.0.0.1' });
  const outbound = { ownHosts: config.ownHosts, resolver, addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }), ca: upstream.ca };
  apiHttp = new OutboundHttp({ ...outbound, connectTimeoutMs: 5_000 });
  proxyHttp = new OutboundHttp({
    ...outbound, connectTimeoutMs: 5_000, totalTimeoutMs: 5_000, maxRequestBytes: config.sizeLimits.requestBodyBytes, maxResponseBytes: bufferLimit,
  });
  setup = await initializeX402({ config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth here'); }, clock }), timeoutMs: 5_000 });

  const logger = createLogger({ level: 'silent' });
  api = createApi({ config, logger, postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: apiHttp, ownership: assumeHostsVerified, internalSecret: Secret.from('internal-secret-0123456789abcdef-xyz') });
  proxy = createApp({ config, logger, postgres: database.postgres, redis, opener: keys.opener, http: proxyHttp, buyerHeaderKey: Secret.from(buyerHeaderKey), x402: setup });
  const [apiPorts, proxyPorts] = await Promise.all([
    api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 }),
    proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 }),
  ]);
  apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  proxyUrl = `http://127.0.0.1:${proxyPorts.port}`;
  await proxy.subscribed;

  seller = await (await fetch(`${apiUrl}/v1/accounts`, { method: 'POST' })).json() as { id: string; masterKey: string };
  serviceId = 'x402-weather' as ServiceId;
  const submitted = await fetch(`${apiUrl}/v1/services/${serviceId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${seller.masterKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ config: serviceYaml(serviceId), secrets: { 'weather-key': 'sk-weather' } }),
  });
  if (submitted.status >= 300)
    throw new Error(`Submit failed: ${await submitted.text()}`);
});

afterAll(async () => {
  await Promise.all([api?.close(), proxy?.close()]);
  await Promise.all([apiHttp?.close(), proxyHttp?.close(), upstream?.close(), facilitator?.close(), rpc?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

beforeEach(() => {
  facilitator.reset();
});

const serviceYaml = (id: string) => `servicerouter:
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

// --- Helpers ---

let counter = 0;
const nextRequestId = (label: string) => {
  counter += 1;

  return `${label}-${counter}`;
};

const buyer = privateKeyToAccount(generatePrivateKey());

const challenge = async (path: string): Promise<{ readonly response: Response; readonly required: PaymentRequired }> => {
  const response = await fetch(`${proxyUrl}/service/${serviceId}${path}`);

  return { response, required: decodePaymentRequiredHeader(response.headers.get('payment-required')!) };
};

/** A PAYMENT-SIGNATURE signed by the official x402 client, with keys made for the test, for the 402's option on `network`. */
const pay = async (path: string, network: string): Promise<string> => {
  const { required } = await challenge(path);
  const client = new x402Client()
    .register(base, new ExactEvmScheme(buyer))
    .register(solana, new ExactSvmScheme(await generateKeyPairSigner(), { rpcUrl: rpc.url }));

  return encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === network) }));
};

const paidCall = async (path: string, network = base, label = 'x402') => {
  const signature = await pay(path, network);
  const requestId = nextRequestId(label);
  const before = { upstream: upstream.requests.length, facilitator: facilitator.requests.length };
  const response = await fetch(`${proxyUrl}/service/${serviceId}${path}`, { headers: { 'payment-signature': signature, 'x-request-id': requestId } });
  const body = await response.text();

  return {
    response,
    body,
    requestId,
    upstreamCalls: () => upstream.requests.length - before.upstream,
    settles: () => facilitator.requests.slice(before.facilitator).filter(request => request.path === '/settle').length,
  };
};

const paymentFor = async (requestId: string): Promise<Payment | undefined> => {
  const { rows } = await database.db.execute<{ id: string }>(sql`select id from payments where request_id = ${requestId}`);

  return rows[0] ? createPaymentRepository({ db: database.db, clock }).find(rows[0].id) : undefined;
};

const earnedOnX402 = async (): Promise<string | undefined> => {
  const earnings = await (await fetch(`${apiUrl}/v1/services/${serviceId}/earnings`, { headers: { authorization: `Bearer ${seller.masterKey}` } })).json() as { earned: { byRail: Record<string, string> } };

  return earnings.earned.byRail['x402'];
};

const followUp = () => createSettlementFollowUp({
  payments: createPaymentRepository({ db: database.db, clock }),
  ledger: createLedger({ db: database.db, clock, ids: { next: () => crypto.randomUUID() } }),
  facilitatorFor: createFacilitatorLookup(config, setup.facilitators),
  assetName: createAssetLookup(config),
  feeBps: config.feeBps,
  logger: createLogger({ level: 'silent' }),
})();

// --- Tests ---

describe('the combined 402 with x402 (PR-2, PR-3, step 5)', () => {
  it('carries the credits block and PAYMENT-REQUIRED with Base and Solana options at the right atomic amounts, and no Cardano', async () => {
    const { response, required } = await challenge('/weather/oslo');
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(402);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({ credits: { price: '0.001' }, x402Version: 2, accepts: required.accepts });
    expect(required).toMatchObject({ x402Version: 2, resource: { url: `https://pay.staging.servicerouter.ai/service/${serviceId}/weather/oslo`, description: 'Current weather' } });
    expect(required.accepts.map(option => [option.network, option.asset, option.amount])).toEqual([
      [base, '0x036CbD53842c5426634e7929541eC2318f3dCF7e', '1000'],
      [solana, '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', '1000'],
    ]);
    expect(required.accepts.some(option => option.network.startsWith('cardano:'))).toBe(false);
  });
});

describe('an x402 payment (PR-5, PR-10, PX-12, step 5)', () => {
  it.each([
    ['Base', base, 'base-usdc'],
    ['Solana', solana, 'solana-usdc'],
  ])('signed on %s by the official client gets 200 through the facilitator, settled, booked, with PAYMENT-RESPONSE', async (_case, network) => {
    const earnedBefore = Number(await earnedOnX402() ?? 0);

    const { response, body, requestId, settles } = await paidCall('/weather/oslo', network);

    expect(response.status).toBe(200);
    const payment = await paymentFor(requestId);
    expect(payment).toMatchObject({
      status: 'settled', rail: 'x402', network, atomicAmount: 1_000n, amount: 1_000n, fee: 25n, decision: 'billable', upstreamStatus: 200,
      sellerAccountId: seller.id, transactionHash: expect.any(String), needsReview: false,
    });
    expect(decodePaymentResponseHeader(response.headers.get('payment-response')!)).toMatchObject({ success: true, network, transaction: payment!.transactionHash });
    expect(response.headers.get('etag')).toBe('"weather-1"');
    expect(settles()).toBe(1);
    expect(Number(await earnedOnX402())).toBeCloseTo(earnedBefore + 0.000975, 6);
    if (network === base)
      expect(JSON.parse(body)).toMatchObject({ buyer: createBuyerHeaderValue(Secret.from(buyerHeaderKey))(`address:${base}:${buyer.address}`, serviceId) });
  });

  it.each([
    ['an upstream 500 the operation declares', '/broken', 500],
    ['the opaque 503 for an undeclared status', '/teapot', 503],
  ])('never settles %s: the payment is cancelled and the facilitator sees no settle', async (_case, path, status) => {
    const { response, requestId, settles } = await paidCall(path);

    expect(response.status).toBe(status);
    expect(response.headers.get('payment-response')).toBeNull();
    expect(settles()).toBe(0);
    expect(await paymentFor(requestId)).toMatchObject({ status: 'cancelled', decision: 'not_billable' });
  });

  it('refuses an invalid payment with 402 payment_invalid, and the upstream records no request', async () => {
    facilitator.handle('/verify', facilitatorAnswers.invalid('invalid_exact_evm_signature'));

    const { response, body, requestId, upstreamCalls } = await paidCall('/weather/oslo');

    expect(response.status).toBe(402);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'payment_invalid', message: 'The facilitator rejected the payment: invalid_exact_evm_signature' } });
    expect(upstreamCalls()).toBe(0);
    expect(await paymentFor(requestId)).toBeUndefined();
  });

  it('answers a response over the buffer limit with 502 response_too_large, uncharged (AR3)', async () => {
    const { response, body, requestId, settles } = await paidCall('/big');

    expect(response.status).toBe(502);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'response_too_large' } });
    expect(body).not.toContain('xxxx');
    expect(settles()).toBe(0);
    expect(await paymentFor(requestId)).toMatchObject({ status: 'cancelled' });
  });

  it('answers a payment key and an x402 payment together with 400 multiple_payment_methods (PR-1)', async () => {
    const signature = await pay('/weather/oslo', base);

    const response = await fetch(`${proxyUrl}/service/${serviceId}/weather/oslo`, { headers: { 'payment-signature': signature, authorization: `Bearer sr_test_${'A'.repeat(43)}` } });

    expect(response.status).toBe(400);
  });
});

describe('settlement outcomes (PR-12, WK-6, step 5)', () => {
  it('sends the response on a pending settlement with a hash and records settling; the worker then finishes and books it', async () => {
    facilitator.handle('/settle', facilitatorAnswers.pending('0xpending0001'));

    const { response, body, requestId } = await paidCall('/weather/bergen');

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ path: '/v2/weather/bergen' });
    expect(decodePaymentResponseHeader(response.headers.get('payment-response')!)).toMatchObject({ errorReason: 'settlement_pending', transaction: '0xpending0001' });
    expect(await paymentFor(requestId)).toMatchObject({ status: 'settling', transactionHash: '0xpending0001' });

    facilitator.reset();
    const result = await followUp();

    expect(result).toMatchObject({ settled: 1 });
    expect(await paymentFor(requestId)).toMatchObject({ status: 'settled', needsReview: false, fee: 25n });
    expect(await followUp()).toEqual({ settled: 0, failed: 0, pending: 0, unknown: 0, skipped: 0 });
  });

  it.each([
    ['a timeout', facilitatorAnswers.timeout(settleTimeoutMs * 4)],
    ['a 503', facilitatorAnswers.unavailable],
  ])('answers %s from settle with 502 settlement_failed and no upstream bytes; the worker later confirms it and flags it for review', async (_case, answer) => {
    facilitator.handle('/settle', answer);

    const { response, body, requestId } = await paidCall('/weather/tromso');

    expect(response.status).toBe(502);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'settlement_failed' } });
    expect(body).not.toContain('/v2/weather');
    expect(response.headers.get('etag')).toBeNull();
    expect(await paymentFor(requestId)).toMatchObject({ status: 'settling', transactionHash: undefined, receipt: undefined });

    facilitator.reset();
    await followUp();

    expect(await paymentFor(requestId)).toMatchObject({ status: 'settled', needsReview: true });
  });

  it('marks a settlement that fails for good as failed: nothing is booked, and the response isn\'t sent', async () => {
    facilitator.handle('/settle', facilitatorAnswers.failed());
    const earnedBefore = await earnedOnX402();

    const { response, requestId } = await paidCall('/weather/narvik');

    expect(response.status).toBe(502);
    expect(await paymentFor(requestId)).toMatchObject({ status: 'failed' });
    expect(await earnedOnX402()).toBe(earnedBefore);
  });
});

describe('readiness with facilitators (PX-17, step 5)', () => {
  it('answers /_/ready with 503 while a facilitator\'s /supported fails, and 200 once it answers again', async () => {
    facilitator.handle('/supported', facilitatorAnswers.unavailable);

    const failing = await fetch(`${proxyUrl}/_/ready`);

    expect(failing.status).toBe(503);
    expect(await failing.json()).toEqual({ status: 'not_ready', checks: { postgres: 'ok', redis: 'ok', 'facilitator:cdp': 'failed' } });
    facilitator.reset();
    expect((await fetch(`${proxyUrl}/_/ready`)).status).toBe(200);
  });
});
