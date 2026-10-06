import { once } from 'node:events';

import { sql } from 'drizzle-orm';
import { Challenge, Receipt } from 'mppx';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp as createApi, type ApiServer } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp, Secret, type ServiceId } from '@servicerouter/common';
import { assumeHostsVerified, facilitatorFee, loadPlatformConfig, type Payment, type PlatformConfig } from '@servicerouter/core';
import { createLedger, createPaymentRepository, createRedis, createRedisReplayStore, type Redis, type RedisReplayStore } from '@servicerouter/db';
import {
  createAssetLookup, createFacilitators, createMppRail, createMppSettlementCheck, initializeMpp, initializeX402, type MppSetup, type Quote,
} from '@servicerouter/payments';
import {
  createFakeClock, createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, createTestTempoPayer, encodeBase58,
  pathUsdAddress, pushMppCredential, startFakeFacilitator, startFakeTempoRpc, startFakeUpstream, tamperMppSignature, type FakeFacilitator,
  type FakeTempoRpc, type FakeUpstream, type TestDatabase, type TestRedis, type TestSecretKeys, type TestTempoPayer,
} from '@servicerouter/testing';
import { createSettlementFollowUp } from '@servicerouter/workers';

import { createApp, type ProxyServer } from '../../src/app.js';
import { createBuyerHeaderValue } from '../../src/payments/buyer.js';

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const tempo = 'eip155:42431';
const recipient = '0x2222222222222222222222222222222222222222';
const buyerHeaderKey = 'buyer-header-key-for-the-mpp-tests-0000';
const mppSecretKey = 'mpp-secret-key-for-the-proxy-tests!!';
const generous = { requests: 100_000, windowSeconds: 60 };
const settleTimeoutMs = 1_000;
const clock = { now: () => new Date() };
const logger = createLogger({ level: 'silent' });
// Every line the first proxy writes, debug included (T24)
const lines: Record<string, unknown>[] = [];
const proxyLogger = createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

const openapi = {
  openapi: '3.1.0',
  info: { title: 'Weather', version: '1.0.0' },
  paths: {
    '/weather/{city}': { get: { operationId: 'getWeather', summary: 'Current weather', responses: { 200: { description: 'OK' } } } },
    '/cheap': { get: { operationId: 'getCheap', responses: { 200: { description: 'OK' } } } },
    '/broken': { get: { operationId: 'getBroken', responses: { 200: { description: 'OK' }, 500: { description: 'Error' } } } },
    '/teapot': { get: { operationId: 'getTeapot', responses: { 200: { description: 'OK' } } } },
  },
};

let database: TestDatabase;
let redis: TestRedis;
// A second connection with the same prefix: another replica's Redis client
let replicaRedis: Redis;
let config: PlatformConfig;
let keys: TestSecretKeys;
let upstream: FakeUpstream;
let facilitator: FakeFacilitator;
let rpc: FakeTempoRpc;
let payer: TestTempoPayer;
let stores: RedisReplayStore[];
let mpp: MppSetup;
let apiHttp: OutboundHttp;
let proxyHttp: OutboundHttp;
let api: ApiServer;
// Two proxy replicas with MPP, sharing Postgres and Redis, and one with MPP off
let proxy: ProxyServer;
let replica: ProxyServer;
let proxyOff: ProxyServer;
let apiUrl: string;
let proxyUrl: string;
let replicaUrl: string;
let offUrl: string;
let metricsUrl: string;
let seller: { readonly id: string; readonly masterKey: string };
let serviceId: ServiceId;

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

routes:
  getCheap:
    payment:
      amount: "0.0001"

credentials:
  main-key:
    type: http
    scheme: bearer
    secret: weather-key
`;

beforeAll(async () => {
  [database, redis, keys, upstream, facilitator, rpc] = await Promise.all([
    createTestDatabase(),
    createTestRedis(),
    createTestSecretKeys(),
    startFakeUpstream({ hosts: ['api.example.com'] }),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }),
    startFakeTempoRpc({ timeoutMs: settleTimeoutMs * 3 }),
  ]);
  payer = createTestTempoPayer({ rpcUrl: rpc.url });
  replicaRedis = createRedis({ url: redis.url, logger, prefix: redis.prefix });
  await once(replicaRedis.client, 'ready');
  const loaded = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        feeBps: 250,
        rateLimits: { signup: generous, paymentKey: generous, service: generous, unpaidIp: generous },
        timeouts: { settleMs: settleTimeoutMs },
        facilitators: [
          // P-2: CDP's flat fee on x402, which MPP never pays
          { name: 'cdp', url: facilitator.url, networks: [base, solana], feePerPayment: '0.0005' },
          { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:preprod'], enabled: false },
        ],
      })).toString('base64'),
    },
  });
  // pathUSD isn't offered below $0.0005, so the $0.0001 route has no Tempo option (PR-3)
  config = { ...loaded, assets: loaded.assets.map(asset => asset.name === 'tempo-pathusd' ? { ...asset, minPrice: 500n } : asset) };
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
    else {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', etag: '"weather-1"' });
      response.end(JSON.stringify({ path: request.path, buyer: request.headers['servicerouter-buyer'] ?? null }));
    }
  });
  const resolver = createFakeResolver({ 'api.example.com': '127.0.0.1' });
  const outbound = { ownHosts: config.ownHosts, resolver, addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }), ca: upstream.ca };
  apiHttp = new OutboundHttp({ ...outbound, connectTimeoutMs: 5_000 });
  proxyHttp = new OutboundHttp({ ...outbound, connectTimeoutMs: 5_000, totalTimeoutMs: 5_000, maxRequestBytes: config.sizeLimits.requestBodyBytes, maxResponseBytes: 1_048_576 });
  const x402 = await initializeX402({ config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth here'); }, clock }), timeoutMs: 5_000 });
  stores = [createRedisReplayStore({ redis }), createRedisReplayStore({ redis: replicaRedis })];
  const mppOn = (store: RedisReplayStore) => initializeMpp({ config, secretKey: Secret.from(mppSecretKey), store, timeoutMs: 5_000, rpcUrl: rpc.url });
  const [first, second] = await Promise.all([mppOn(stores[0]!), mppOn(stores[1]!)]);
  mpp = first;

  api = createApi({ config, logger, postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: apiHttp, ownership: assumeHostsVerified, internalSecret: Secret.from('internal-secret-0123456789abcdef-xyz') });
  const proxyOf = (setup: MppSetup | undefined, connection: Redis, appLogger = logger) => createApp({
    config, logger: appLogger, postgres: database.postgres, redis: connection, opener: keys.opener, http: proxyHttp, buyerHeaderKey: Secret.from(buyerHeaderKey), x402,
    ...(setup ? { mpp: setup } : {}),
  });
  proxy = proxyOf(first, redis, proxyLogger);
  replica = proxyOf(second, replicaRedis);
  proxyOff = proxyOf(undefined, redis);
  const listen = { host: '127.0.0.1', port: 0, metricsPort: 0 };
  const [apiPorts, proxyPorts, replicaPorts, offPorts] = await Promise.all([
    api.listen({ ...listen, internalPort: 0 }),
    proxy.listen(listen),
    replica.listen(listen),
    proxyOff.listen(listen),
  ]);
  apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  proxyUrl = `http://127.0.0.1:${proxyPorts.port}`;
  replicaUrl = `http://127.0.0.1:${replicaPorts.port}`;
  offUrl = `http://127.0.0.1:${offPorts.port}`;
  metricsUrl = `http://127.0.0.1:${proxyPorts.metricsPort}/metrics`;
  await Promise.all([proxy.subscribed, replica.subscribed, proxyOff.subscribed]);

  seller = await (await fetch(`${apiUrl}/v1/accounts`, { method: 'POST' })).json() as { id: string; masterKey: string };
  serviceId = 'mpp-weather' as ServiceId;
  const submitted = await fetch(`${apiUrl}/v1/services/${serviceId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${seller.masterKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ config: serviceYaml(serviceId), secrets: { 'weather-key': 'sk-weather' } }),
  });
  if (submitted.status >= 300)
    throw new Error(`Submit failed: ${await submitted.text()}`);
});

afterAll(async () => {
  await Promise.all([api?.close(), proxy?.close(), replica?.close(), proxyOff?.close()]);
  await Promise.all([...(stores ?? []).map(store => store.close()), replicaRedis?.close()]);
  await Promise.all([apiHttp?.close(), proxyHttp?.close(), upstream?.close(), facilitator?.close(), rpc?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

beforeEach(() => {
  facilitator.reset();
  rpc.reset();
});

// --- Helpers ---

let counter = 0;
const nextRequestId = (label: string) => {
  counter += 1;

  return `${label}-${counter}`;
};

const urlOf = (path: string, at = proxyUrl) => `${at}/service/${serviceId}${path}`;

const challenge = (path: string, at = proxyUrl): Promise<Response> => fetch(urlOf(path, at));

/** A credential `mppx`'s client signs, with a key made for the test, for the 402's Tempo charge. */
const pay = async (path: string): Promise<string> => payer.credentialFor(await challenge(path));

const send = async (path: string, credential: string, { at = proxyUrl, label = 'mpp' } = {}) => {
  const requestId = nextRequestId(label);
  const before = { upstream: upstream.requests.length, broadcasts: rpc.rawTransactions.length };
  const response = await fetch(urlOf(path, at), { headers: { authorization: credential, 'x-request-id': requestId } });
  const body = await response.text();

  return {
    response,
    body,
    requestId,
    upstreamCalls: () => upstream.requests.length - before.upstream,
    broadcasts: () => rpc.rawTransactions.length - before.broadcasts,
  };
};

const paidCall = async (path: string, label = 'mpp') => send(path, await pay(path), { label });

const paymentFor = async (requestId: string): Promise<Payment | undefined> => {
  const { rows } = await database.db.execute<{ id: string }>(sql`select id from payments where request_id = ${requestId}`);

  return rows[0] ? createPaymentRepository({ db: database.db, clock }).find(rows[0].id) : undefined;
};

const earnedOnMpp = async (): Promise<number> => {
  const earnings = await (await fetch(`${apiUrl}/v1/services/${serviceId}/earnings`, { headers: { authorization: `Bearer ${seller.masterKey}` } })).json() as { earned: { byRail: Record<string, string> } };

  return Number(earnings.earned.byRail['mpp'] ?? 0);
};

const metricValue = async (series: string): Promise<number> => {
  const line = (await (await fetch(metricsUrl)).text()).split('\n').find(candidate => candidate.startsWith(`${series} `));

  return line ? Number(line.split(' ')[1]) : 0;
};

const followUp = (now = clock) => createSettlementFollowUp({
  payments: createPaymentRepository({ db: database.db, clock }),
  ledger: createLedger({ db: database.db, clock, ids: { next: () => crypto.randomUUID() } }),
  facilitatorFor: () => undefined,
  assetName: createAssetLookup(config),
  mppCheck: createMppSettlementCheck({ rpc: mpp.rpc, timeoutMs: 1_000, clock: now }),
  feeBps: config.feeBps,
  feePerPayment: network => facilitatorFee(config, network),
  logger,
})();

// The 402 another MPP server would issue for the same URL, such as one paying another recipient
const foreignChallenge = async (setup: MppSetup, price: bigint): Promise<Response> => {
  const quote: Quote = {
    paymentId: 'pay_foreign',
    requestId: undefined,
    resource: `https://pay.staging.servicerouter.ai/service/${serviceId}/weather/oslo`,
    priceMicroUsd: price,
    description: 'Current weather',
    subject: { kind: 'service', serviceId, routeKey: 'getWeather', sellerAccountId: seller.id },
    feeBps: 250,
  };
  const rail = createMppRail({ setup, recorder: {} as never, ledger: {} as never, logger, clock, settleTimeoutMs });

  return new Response(null, { status: 402, headers: (await rail.challenge(quote))!.headers });
};

// --- Tests ---

describe('the combined 402 with MPP (PR-2, PR-3, PR-9, PX-16, step 7)', () => {
  it('carries WWW-Authenticate: Payment with a Tempo charge in pathUSD on Moderato, beside the x402 options and the credits block', async () => {
    const response = await challenge('/weather/oslo');
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(402);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const challenges = Challenge.deserializeList(response.headers.get('www-authenticate')!);
    expect(challenges).toEqual([expect.objectContaining({
      method: 'tempo',
      intent: 'charge',
      realm: 'pay.staging.servicerouter.ai',
      request: { amount: '1000', currency: pathUsdAddress, recipient, methodDetails: { chainId: 42_431, supportedModes: ['pull'] } },
    })]);
    expect(response.headers.get('payment-required')).not.toBeNull();
    expect(body).toMatchObject({ credits: { price: '0.001' }, x402Version: 2 });
    expect((body['accepts'] as { network: string }[]).map(option => option.network)).toEqual([base, solana]);
    expect(response.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
    expect(response.headers.get('access-control-expose-headers')).toContain('Payment-Receipt');
  });

  it('offers no Tempo option below the asset\'s minimum price, and keeps the others (PR-3)', async () => {
    const response = await challenge('/cheap');

    expect(response.status).toBe(402);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(response.headers.get('payment-required')).not.toBeNull();
  });

  it('offers no MPP challenge with MPP off, and answers an MPP credential with the combined 402', async () => {
    const credential = await pay('/weather/oslo');

    const offered = await challenge('/weather/oslo', offUrl);
    const { response, upstreamCalls } = await send('/weather/oslo', credential, { at: offUrl });

    expect(offered.headers.get('www-authenticate')).toBeNull();
    expect(response.status).toBe(402);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(upstreamCalls()).toBe(0);
  });
});

describe('an MPP payment (PR-9, PR-10, PX-5, PX-12, PX-15, step 7)', () => {
  it('signed by mppx\'s client gets 200 through the fake Tempo RPC, settled and booked, with Payment-Receipt and private caching', async () => {
    const earnedBefore = await earnedOnMpp();

    const { response, body, requestId, broadcasts } = await paidCall('/weather/oslo');
    const forwarded = upstream.requests.at(-1)!;

    expect(response.status).toBe(200);
    const payment = await paymentFor(requestId);
    expect(payment).toMatchObject({
      status: 'settled', rail: 'mpp', network: tempo, asset: pathUsdAddress, atomicAmount: 1_000n, amount: 1_000n, fee: 25n, decision: 'billable',
      upstreamStatus: 200, sellerAccountId: seller.id, transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), needsReview: false,
    });
    expect(Receipt.deserialize(response.headers.get('payment-receipt')!)).toMatchObject({ method: 'tempo', status: 'success', reference: payment!.transactionHash });
    expect(response.headers.get('cache-control')).toBe('max-age=60, private');
    expect(response.headers.get('etag')).toBe('"weather-1"');
    expect(broadcasts()).toBe(1);
    expect(await earnedOnMpp()).toBeCloseTo(earnedBefore + 0.000975, 6);
    expect(JSON.parse(body)).toMatchObject({ buyer: createBuyerHeaderValue(Secret.from(buyerHeaderKey))(`address:${tempo}:${payer.address.toLowerCase()}`, serviceId) });
    expect(rpc.unknownMethods).toEqual([]);
    // PX-5: the credential never reaches the upstream, which gets the seller's own
    expect(forwarded.headers['authorization']).toBe('Bearer sk-weather');
  });

  it.each([
    ['an upstream 500 the operation declares', '/broken', 500],
    ['the opaque 503 for an undeclared status', '/teapot', 503],
  ])('never broadcasts %s: the payment is cancelled and nothing is booked', async (_case, path, status) => {
    const earnedBefore = await earnedOnMpp();

    const { response, requestId, broadcasts } = await paidCall(path);

    expect(response.status).toBe(status);
    expect(response.headers.get('payment-receipt')).toBeNull();
    expect(broadcasts()).toBe(0);
    expect(rpc.rawTransactions).toEqual([]);
    expect(await paymentFor(requestId)).toMatchObject({ status: 'cancelled', decision: 'not_billable' });
    expect(await earnedOnMpp()).toBe(earnedBefore);
  });

  it('refuses the same credential sent again to a second proxy instance on the same Redis: 402 payment_invalid, broadcast once', async () => {
    const credential = await pay('/weather/oslo');

    const first = await send('/weather/oslo', credential);
    const again = await send('/weather/oslo', credential, { at: replicaUrl });

    expect(first.response.status).toBe(200);
    expect(again.response.status).toBe(402);
    expect(JSON.parse(again.body)).toMatchObject({ error: { code: 'payment_invalid', message: expect.stringContaining('already used') } });
    expect(again.upstreamCalls()).toBe(0);
    expect(rpc.rawTransactions).toHaveLength(1);
    expect(await paymentFor(again.requestId)).toBeUndefined();
  });

  it.each([
    ['a push credential', async () => pushMppCredential(await challenge('/weather/oslo'), payer.address)],
    ['a credential for another amount', async () => payer.credentialFor(await foreignChallenge(mpp, 2_000n))],
    ['a credential for another recipient', async () => {
      const otherRecipient = '0x3333333333333333333333333333333333333333';
      const other = await initializeMpp({
        config: { ...config, mpp: { ...config.mpp, recipient: otherRecipient } },
        secretKey: Secret.from(mppSecretKey),
        store: stores[0]!,
        timeoutMs: 5_000,
        rpcUrl: rpc.url,
      });

      return payer.credentialFor(await foreignChallenge(other, 1_000n));
    }],
    ['a credential with a bad signature', async () => tamperMppSignature(await pay('/weather/oslo'))],
  ])('refuses %s with 402 payment_invalid before the upstream is called', async (_case, credential) => {
    const refusedBefore = await metricValue('proxy_payments_total{rail="mpp",outcome="payment_invalid"}');

    const { response, body, requestId, upstreamCalls } = await send('/weather/oslo', await credential());

    expect(response.status).toBe(402);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'payment_invalid' } });
    expect(upstreamCalls()).toBe(0);
    expect(rpc.rawTransactions).toEqual([]);
    expect(await paymentFor(requestId)).toBeUndefined();
    expect(await metricValue('proxy_payments_total{rail="mpp",outcome="payment_invalid"}')).toBe(refusedBefore + 1);
  });

  it('answers 503 payment_unavailable while the Tempo RPC doesn\'t answer the check: nothing paid, no upstream call', async () => {
    const credential = await pay('/weather/oslo');
    rpc.unavailable(true);

    const { response, body, upstreamCalls } = await send('/weather/oslo', credential);

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'payment_unavailable' } });
    expect(upstreamCalls()).toBe(0);
  });

  it('takes no flat fee, though CDP takes one on x402: feeBps\'s share only (P-2)', async () => {
    expect([facilitatorFee(config, base), facilitatorFee(config, tempo)]).toEqual([500n, 0n]);

    const { response, requestId } = await paidCall('/weather/oslo');

    expect(response.status).toBe(200);
    expect(await paymentFor(requestId)).toMatchObject({ status: 'settled', rail: 'mpp', amount: 1_000n, fee: 25n });
  });
});

describe('MPP settlement outcomes (PR-9, PR-12, WK-6, step 7)', () => {
  it('answers a reverted transaction with 502 settlement_failed and no upstream bytes: failed, nothing booked', async () => {
    const earnedBefore = await earnedOnMpp();
    const credential = await pay('/weather/narvik');
    rpc.broadcast('revert');

    const { response, body, requestId } = await send('/weather/narvik', credential);

    expect(response.status).toBe(502);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'settlement_failed' } });
    expect(body).not.toContain('/v2/weather');
    expect(response.headers.get('etag')).toBeNull();
    expect(await paymentFor(requestId)).toMatchObject({ status: 'failed' });
    expect(await earnedOnMpp()).toBe(earnedBefore);
  });

  it('answers an RPC timeout with 502, keeping the payment settling with its hash; the follow-up books it once, flagged for review', async () => {
    const earnedBefore = await earnedOnMpp();
    const credential = await pay('/weather/tromso');
    rpc.broadcast('timeout');

    const { response, body, requestId } = await send('/weather/tromso', credential);

    expect(response.status).toBe(502);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'settlement_failed' } });
    expect(body).not.toContain('/v2/weather');
    const settling = await paymentFor(requestId);
    expect(settling).toMatchObject({ status: 'settling', transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), receipt: undefined });

    rpc.reset();
    expect(await followUp()).toMatchObject({ pending: 1, settled: 0 });
    rpc.include(settling!.transactionHash as `0x${string}`);
    expect(await followUp()).toMatchObject({ settled: 1 });

    expect(await paymentFor(requestId)).toMatchObject({ status: 'settled', needsReview: true, fee: 25n, transactionHash: settling!.transactionHash });
    expect(await earnedOnMpp()).toBeCloseTo(earnedBefore + 0.000975, 6);
    expect(await followUp()).toEqual({ settled: 0, failed: 0, pending: 0, unknown: 0, skipped: 0 });
    expect(rpc.rawTransactions).toEqual([]);
  });

  it('ends a transaction never included once its validity window has passed: failed, nothing booked', async () => {
    const earnedBefore = await earnedOnMpp();
    const credential = await pay('/weather/bodo');
    rpc.broadcast('timeout');
    const { response, requestId } = await send('/weather/bodo', credential);
    expect(response.status).toBe(502);

    rpc.reset();
    const later = createFakeClock(new Date(Date.now() + 10 * 60_000));
    expect(await followUp(later)).toMatchObject({ failed: 1 });

    expect(await paymentFor(requestId)).toMatchObject({ status: 'failed' });
    expect(await earnedOnMpp()).toBe(earnedBefore);
  });
});

describe('readiness with MPP (PX-17, PR-9)', () => {
  it('answers /_/ready with 503 while the Tempo RPC fails, and 200 once it answers again', async () => {
    rpc.unavailable(true);

    const failing = await fetch(`${proxyUrl}/_/ready`);

    expect(failing.status).toBe(503);
    expect(await failing.json()).toEqual({ status: 'not_ready', checks: { postgres: 'ok', redis: 'ok', 'facilitator:cdp': 'ok', mpp: 'failed' } });
    rpc.unavailable(false);
    expect((await fetch(`${proxyUrl}/_/ready`)).status).toBe(200);
  });
});

describe('MPP diagnostics (L-3, L-9)', () => {
  const linesOf = (requestId: string) => lines.filter(line => line['requestId'] === requestId);

  it('logs a paid MPP call once, with its network, asset, and transaction', async () => {
    const { response, requestId } = await paidCall('/weather/oslo', 'mpp-logs');

    expect(response.status).toBe(200);
    expect(linesOf(requestId).filter(line => line['msg'] === 'Paid call finished')).toEqual([expect.objectContaining({
      level: 30, rail: 'mpp', network: tempo, asset: 'tempo-pathusd', amount: '0.001', decision: 'billable', paymentStatus: 'settled',
      transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/), upstreamStatus: 200,
    })]);
  });

  it('logs an RPC error with viem\'s short message only: never the signed transaction its request carried', async () => {
    const credential = await pay('/weather/oslo');
    rpc.broadcast('fail');

    const { response, requestId } = await send('/weather/oslo', credential, { label: 'mpp-rpc-error' });

    expect(response.status).toBe(502);
    expect(linesOf(requestId).find(line => line['msg'] === 'The MPP broadcast\'s outcome is unknown. The settlement follow-up reads its receipt.')).toMatchObject({
      level: 40, reason: 'HTTP request failed.', network: tempo, transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    expect(linesOf(requestId).find(line => line['msg'] === 'Paid call failed to settle')).toMatchObject({
      level: 40, rail: 'mpp', paymentStatus: 'settling', outcome: 'unknown', reason: 'HTTP request failed.',
    });
    expect(linesOf(requestId).find(line => line['msg'] === 'Request failed')).toMatchObject({
      error: { code: 'settlement_failed', cause: { type: 'HttpRequestError', message: 'HTTP request failed.', status: 503 } },
    });
    const logged = JSON.stringify(linesOf(requestId));
    expect(rpc.rawTransactions.length).toBeGreaterThan(0);
    for (const raw of rpc.rawTransactions)
      expect(logged).not.toContain(raw.slice(2, 66));
    expect(logged).not.toContain(credential.slice(-40));
    expect(logged).not.toMatch(/Request body|eth_sendRawTransaction/);
  });

  it('logs a Tempo RPC that doesn\'t answer the check as the platform\'s fault, with its short message', async () => {
    const credential = await pay('/weather/oslo');
    rpc.unavailable(true);

    const { response, requestId } = await send('/weather/oslo', credential, { label: 'mpp-rpc-down' });

    expect(response.status).toBe(503);
    expect(linesOf(requestId).find(line => line['msg'] === 'The Tempo RPC didn\'t answer while an MPP payment was checked')).toMatchObject({
      level: 40, network: tempo, reason: expect.any(String),
    });
    expect(linesOf(requestId).find(line => line['msg'] === 'Paid call refused: the payment couldn\'t be checked')).toMatchObject({ level: 40, rail: 'mpp', code: 'payment_unavailable' });
  });

  it('never logs an MPP credential, the challenges\' key, or a seller secret', async () => {
    const credential = await pay('/weather/bergen');
    await send('/weather/bergen', credential, { label: 'mpp-secrets' });

    const logged = JSON.stringify(lines);
    for (const secret of [credential, credential.slice(-40), mppSecretKey, buyerHeaderKey, 'sk-weather', seller.masterKey])
      expect(logged).not.toContain(secret);
  });
});
