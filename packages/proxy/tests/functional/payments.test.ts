import { request as httpRequest } from 'node:http';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp as createApi, type ApiServer } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp, Secret, type ServiceId } from '@servicerouter/common';
import { assumeHostsVerified, loadPlatformConfig, type Payment, type PlatformConfig } from '@servicerouter/core';
import { createPaymentRepository } from '@servicerouter/db';
import {
  createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, startFakeUpstream, type FakeUpstream, type TestDatabase,
  type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createApp, type ProxyServer } from '../../src/app.js';
import { createBuyerHeaderValue } from '../../src/payments/buyer.js';

const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const buyerHeaderKey = 'buyer-header-key-for-the-payment-tests';
const generous = { requests: 100_000, windowSeconds: 60 };

const loadConfig = (overrides: Record<string, unknown>) => loadPlatformConfig({
  env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from(JSON.stringify(overrides)).toString('base64') },
});

const openapi = {
  openapi: '3.1.0',
  info: { title: 'Weather', version: '1.0.0' },
  paths: {
    '/weather/{city}': { get: { operationId: 'getWeather', summary: 'Current weather', responses: { 200: { description: 'OK' } } } },
    '/free': { get: { operationId: 'getFree', responses: { 200: { description: 'OK' } } } },
    '/pricey': { get: { operationId: 'getPricey', responses: { 200: { description: 'OK' } } } },
    '/missing': { get: { operationId: 'getMissing', responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } } } },
    '/broken': { get: { operationId: 'getBroken', responses: { 200: { description: 'OK' }, 500: { description: 'Error' } } } },
    '/teapot': { get: { operationId: 'getTeapot', responses: { 200: { description: 'OK' } } } },
    '/reset': { get: { operationId: 'getReset', responses: { 200: { description: 'OK' } } } },
    '/stream': { get: { operationId: 'getStream', responses: { 200: { description: 'OK' } } } },
  },
};

let database: TestDatabase;
let redis: TestRedis;
let limitsRedis: TestRedis;
let config: PlatformConfig;
let keys: TestSecretKeys;
let upstream: FakeUpstream;
let apiHttp: OutboundHttp;
let proxyHttp: OutboundHttp;
let api: ApiServer;
let proxy: ProxyServer;
let limitedProxy: ProxyServer;
let apiUrl: string;
let internalUrl: string;
let proxyUrl: string;
let proxyPort: number;
let limitedUrl: string;
let metricsUrl: string;
let apiMetricsUrl: string;
let counter = 0;
// Ends the upstream's /stream response
let endStream: (() => void) | undefined;

beforeAll(async () => {
  let limitedConfig: PlatformConfig;
  [database, redis, limitsRedis, config, limitedConfig, keys, upstream] = await Promise.all([
    createTestDatabase(),
    createTestRedis(),
    createTestRedis(),
    loadConfig({ feeBps: 250, rateLimits: { signup: generous, paymentKey: generous, service: generous, unpaidIp: generous } }),
    loadConfig({
      feeBps: 250,
      rateLimits: { signup: generous, paymentKey: { requests: 2, windowSeconds: 60 }, service: { requests: 3, windowSeconds: 60 }, unpaidIp: { requests: 2, windowSeconds: 30 } },
    }),
    createTestSecretKeys(),
    startFakeUpstream({ hosts: ['api.example.com'] }),
  ]);
  upstream.handle((request, response) => {
    const path = request.path.split('?')[0]!;
    if (path === '/openapi.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(openapi));
    }
    else if (path === '/v2/missing')
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no such thing"}');
    else if (path === '/v2/broken')
      response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
    else if (path === '/v2/teapot')
      response.writeHead(418).end('teapot');
    else if (path === '/v2/reset')
      response.socket?.destroy();
    else if (path === '/v2/stream') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('first chunk\n');
      endStream = () => response.end('last chunk\n');
    }
    else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ path: request.path, buyer: request.headers['servicerouter-buyer'] ?? null }));
    }
  });
  const resolver = createFakeResolver({ 'api.example.com': '127.0.0.1' });
  const outbound = { ownHosts: config.ownHosts, resolver, addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }), ca: upstream.ca };
  apiHttp = new OutboundHttp({ ...outbound, connectTimeoutMs: 5_000 });
  proxyHttp = new OutboundHttp({
    ...outbound,
    connectTimeoutMs: config.timeouts.connectMs,
    totalTimeoutMs: 5_000,
    maxRequestBytes: config.sizeLimits.requestBodyBytes,
    maxResponseBytes: config.sizeLimits.bufferedResponseBytes,
  });

  const logger = createLogger({ level: 'silent' });
  api = createApi({ config, logger, postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: apiHttp, ownership: assumeHostsVerified, internalSecret: Secret.from(internalSecret) });
  const proxyDependencies = { logger, postgres: database.postgres, opener: keys.opener, http: proxyHttp, buyerHeaderKey: Secret.from(buyerHeaderKey) };
  proxy = createApp({ ...proxyDependencies, config, redis });
  limitedProxy = createApp({ ...proxyDependencies, config: limitedConfig, redis: limitsRedis });
  const [apiPorts, proxyPorts, limitedPorts] = await Promise.all([
    api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 }),
    proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 }),
    limitedProxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 }),
  ]);
  apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  apiMetricsUrl = `http://127.0.0.1:${apiPorts.metricsPort}`;
  internalUrl = `http://127.0.0.1:${apiPorts.internalPort!}`;
  proxyPort = proxyPorts.port;
  proxyUrl = `http://127.0.0.1:${proxyPort}`;
  metricsUrl = `http://127.0.0.1:${proxyPorts.metricsPort}`;
  limitedUrl = `http://127.0.0.1:${limitedPorts.port}`;
  await Promise.all([proxy.subscribed, limitedProxy.subscribed]);
});

afterAll(async () => {
  endStream?.();
  await Promise.all([api?.close(), proxy?.close(), limitedProxy?.close()]);
  await Promise.all([apiHttp?.close(), proxyHttp?.close(), upstream?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup(), limitsRedis?.cleanup()]);
});

// --- Helpers ---

interface Account {
  readonly id: string;
  readonly masterKey: string;
}

const signup = async (): Promise<Account> => await (await fetch(`${apiUrl}/v1/accounts`, { method: 'POST' })).json() as Account;

const apiCall = async (account: Account, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${account.masterKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

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
  getFree:
    payment:
      amount: "0"
  getPricey:
    payment:
      amount: "0.05"

credentials:
  main-key:
    type: http
    scheme: bearer
    secret: weather-key
`;

interface Seller extends Account {
  readonly serviceId: ServiceId;
}

/** A seller account with a live service: $0.001 a call, `/free` at 0, `/pricey` at $0.05. */
const newSeller = async (): Promise<Seller> => {
  counter += 1;
  const seller = await signup();
  const serviceId = `paid-${counter}` as ServiceId;
  const submitted = await apiCall(seller, 'PUT', `/v1/services/${serviceId}`, { config: serviceYaml(serviceId), secrets: { 'weather-key': `sk-${counter}` } });
  if (submitted.status >= 300)
    throw new Error(`Submit failed: ${JSON.stringify(submitted.body)}`);

  return { ...seller, serviceId };
};

interface Buyer extends Account {
  readonly key: string;
  readonly keyId: string;
}

/** A buyer with a payment key and a credited balance. */
const newBuyer = async ({ credit = '1', limits = {} }: { credit?: string; limits?: Record<string, string> } = {}): Promise<Buyer> => {
  counter += 1;
  const buyer = await signup();
  const created = await apiCall(buyer, 'POST', '/v1/keys', { dailyBudget: '100', ...limits });
  if (credit !== '0') {
    const credited = await fetch(`${internalUrl}/internal/v1/accounts/${buyer.id}/credits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': internalSecret },
      body: JSON.stringify({ amount: credit, reference: `credit-${counter}` }),
    });
    expect(credited.status).toBe(201);
  }

  return { ...buyer, key: created.body['key'] as string, keyId: created.body['id'] as string };
};

const call = async (seller: Seller, path: string, headers: Record<string, string> = {}, base = proxyUrl) =>
  fetch(`${base}/service/${seller.serviceId}${path}`, { headers });

const paid = (buyer: Buyer, headers: Record<string, string> = {}) => ({ authorization: `Bearer ${buyer.key}`, ...headers });

const balance = async (account: Account) => (await apiCall(account, 'GET', '/v1/balance')).body;

const paymentsOf = async (buyer: Account): Promise<readonly Payment[]> =>
  (await createPaymentRepository({ db: database.db, clock: { now: () => new Date() } }).listForBuyer({ buyerAccountId: buyer.id, limit: 100 })).payments;

const paymentFor = async (requestId: string): Promise<Payment | undefined> => {
  const { rows } = await database.db.execute<{ id: string }>(sql`select id from payments where request_id = ${requestId}`);

  return rows[0] ? createPaymentRepository({ db: database.db, clock: { now: () => new Date() } }).find(rows[0].id) : undefined;
};

/** Waits until the response's payment is finished: finalize runs once the response is out. */
const settled = async (requestId: string): Promise<Payment> => {
  let payment: Payment | undefined;
  await vi.waitFor(async () => {
    payment = await paymentFor(requestId);
    expect(payment?.status).toMatch(/^(captured|released)$/);
  });

  return payment!;
};

const nextRequestId = (label: string) => {
  counter += 1;

  return `${label}-${counter}`;
};

const metricValue = async (series: string): Promise<number> => {
  const line = (await (await fetch(`${metricsUrl}/metrics`)).text()).split('\n').find(text => text.startsWith(`${series} `));

  return line ? Number(line.slice(series.length + 1)) : 0;
};

const upstreamCalls = () => upstream.requests.filter(request => !request.path.startsWith('/openapi.json')).length;

// --- Tests ---

describe('a paid call (PR-4, rule 5, PX-11, PX-12, step 4)', () => {
  it('holds, forwards, records the decision, captures, and sends the receipt; the seller\'s earnings and the fee appear in the ledger', async () => {
    const [seller, buyer] = [await newSeller(), await newBuyer({ credit: '1' })];
    const requestId = nextRequestId('paid');
    const capturedBefore = await metricValue('proxy_payments_total{rail="credits",outcome="captured"}');

    const response = await call(seller, '/weather/oslo', paid(buyer, { 'x-request-id': requestId }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path: '/v2/weather/oslo' });
    const payment = await settled(requestId);
    expect(payment).toMatchObject({
      status: 'captured', rail: 'credits', kind: 'service', amount: 1_000n, fee: 25n, buyerAccountId: buyer.id, keyId: buyer.keyId,
      sellerAccountId: seller.id, serviceId: seller.serviceId, routeKey: 'getWeather', decision: 'billable', upstreamStatus: 200,
    });
    expect(payment.upstreamLatencyMs).toBeTypeOf('number');
    expect(response.headers.get('servicerouter-receipt')).toBe(`id="${payment.id}", amount="0.001", currency="USD"`);
    expect(await balance(buyer)).toEqual({ available: '0.999', held: '0' });
    const earnings = await apiCall(seller, 'GET', `/v1/services/${seller.serviceId}/earnings`);
    expect(earnings.body).toMatchObject({ calls: 1, earned: { total: '0.000975', byRail: { credits: '0.000975' } }, fee: '0.000025' });
    expect(await metricValue('proxy_payments_total{rail="credits",outcome="captured"}')).toBe(capturedBefore + 1);
  });

  it('exposes the receipt and the payment headers to browsers (PX-16)', async () => {
    const [seller, buyer] = [await newSeller(), await newBuyer()];

    const response = await call(seller, '/weather/bergen', paid(buyer, { origin: 'https://app.example.org' }));

    const exposed = response.headers.get('access-control-expose-headers')!.split(', ');
    expect(exposed).toEqual(expect.arrayContaining(['Servicerouter-Receipt', 'PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'WWW-Authenticate', 'Payment-Receipt', 'x-request-id']));
    expect(response.headers.get('servicerouter-receipt')).toMatch(/^id="pay_/);
  });

  it.each([
    ['an upstream 404 the operation declares', '/missing', 404],
    ['an upstream 500 the operation declares', '/broken', 500],
    ['the opaque 503 for a status the operation doesn\'t declare (PX-7)', '/teapot', 503],
    ['the opaque 503 for a dropped connection (PX-7)', '/reset', 503],
  ])('releases the hold on %s: the buyer\'s balance is unchanged and the payment is released', async (_case, path, status) => {
    const [seller, buyer] = [await newSeller(), await newBuyer({ credit: '1' })];
    const requestId = nextRequestId('released');

    const response = await call(seller, path, paid(buyer, { 'x-request-id': requestId }));

    expect(response.status).toBe(status);
    expect(response.headers.get('servicerouter-receipt')).toBeNull();
    await response.arrayBuffer();
    expect(await settled(requestId)).toMatchObject({ status: 'released', decision: 'not_billable', upstreamStatus: status === 503 ? undefined : status });
    expect(await balance(buyer)).toEqual({ available: '1', held: '0' });
    expect((await apiCall(buyer, 'GET', '/v1/keys')).body).toMatchObject({ keys: [{ spent: { today: '0', total: '0' } }] });
  });

  it('streams the response, and a client that leaves after the decision still follows it (PX-12, rule 5)', async () => {
    const [seller, buyer] = [await newSeller(), await newBuyer({ credit: '1' })];
    const requestId = nextRequestId('stream');

    const firstChunk = await new Promise<string>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1', port: proxyPort, path: `/service/${seller.serviceId}/stream`, headers: paid(buyer, { 'x-request-id': requestId }),
      }, response => {
        response.once('data', (chunk: Buffer) => {
          // Streamed: the first chunk arrives before the upstream has finished
          resolve(chunk.toString('utf8'));
          request.destroy();
        });
      });
      request.on('error', reject);
      request.end();
    });
    endStream?.();

    expect(firstChunk).toBe('first chunk\n');
    expect(await settled(requestId)).toMatchObject({ status: 'captured', decision: 'billable' });
    expect(await balance(buyer)).toEqual({ available: '0.999', held: '0' });
  });

  it('pays and forwards without calling the Platform API: only Postgres, Redis, and the upstream (PX-14, rule 1)', async () => {
    const [seller, buyer] = [await newSeller(), await newBuyer()];
    const apiRequests = async () => (await (await fetch(`${apiMetricsUrl}/metrics`)).text()).split('\n')
      .filter(line => line.startsWith('http_requests_total{'))
      .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)), 0);
    const requestId = nextRequestId('local');
    const before = await apiRequests();

    const response = await call(seller, '/weather/oslo', paid(buyer, { 'x-request-id': requestId }));
    await response.arrayBuffer();
    await settled(requestId);

    expect(response.status).toBe(200);
    // The API did serve the setup's signups, keys, and submits
    expect(before).toBeGreaterThan(0);
    expect(await apiRequests()).toBe(before);
  });

  it('serves an operation priced at 0 without any payment', async () => {
    const seller = await newSeller();
    const requestId = nextRequestId('free');

    const response = await call(seller, '/free', { 'x-request-id': requestId });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path: '/v2/free', buyer: null });
    expect(await paymentFor(requestId)).toBeUndefined();
  });
});

describe('concurrent paid calls through the proxy (step 4, LG-6, AK-7)', () => {
  it.each([
    ['the balance', { credit: '0.03', limits: {} }, 30, 'insufficient_balance'],
    ['the daily budget', { credit: '1', limits: { dailyBudget: '0.025' } }, 25, 'key_budget_exceeded'],
    ['the allowance', { credit: '1', limits: { allowance: '0.02' } }, 20, 'key_allowance_exceeded'],
  ] as const)('never pass %s: 50 calls at once, and the accepted ones fit exactly', async (_case, setup, fits, refusal) => {
    const [seller, buyer] = [await newSeller(), await newBuyer(setup)];

    const responses = await Promise.all(Array.from({ length: 50 }, async () => {
      const response = await call(seller, '/weather/oslo', paid(buyer));

      return { status: response.status, body: await response.json() as { error?: { code: string } } };
    }));

    expect(responses.filter(response => response.status === 200)).toHaveLength(fits);
    expect(responses.filter(response => response.status === 402).map(response => response.body.error?.code)).toEqual(Array.from({ length: 50 - fits }, () => refusal));
    await vi.waitFor(async () => expect(await balance(buyer)).toMatchObject({ held: '0' }));
    const credited = Number(setup.credit) * 1_000_000;
    expect(await balance(buyer)).toEqual({ available: String((credited - fits * 1_000) / 1_000_000), held: '0' });
    expect((await paymentsOf(buyer)).map(payment => payment.status)).toEqual(Array.from({ length: fits }, () => 'captured'));
    const { rows } = await database.db.execute(sql`select ledger_account_id from balances where balance < 0 and not may_go_negative`);
    expect(rows).toEqual([]);
  });
});

describe('credentials (PR-1, AK-4)', () => {
  it('answers a call without a credential with the combined 402: the credits block, never cached, and the upstream isn\'t called (PR-2)', async () => {
    const seller = await newSeller();
    const before = upstreamCalls();

    const response = await call(seller, '/weather/oslo');

    expect(response.status).toBe(402);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      credits: {
        price: '0.001',
        currency: 'USD',
        authorization: 'Bearer <payment key>',
        signup: { method: 'POST', url: 'https://api.staging.servicerouter.ai/v1/accounts' },
        guide: 'https://staging.servicerouter.ai/llms.txt',
      },
    });
    expect(upstreamCalls()).toBe(before);
  });

  it.each([
    ['x402 alone, until step 5', { 'payment-signature': 'eyJ4NDAyVmVyc2lvbiI6Mn0' }],
    ['MPP alone, until step 7', { authorization: 'Payment id="abc"' }],
  ])('answers %s with the combined 402', async (_case, headers) => {
    const seller = await newSeller();

    const response = await call(seller, '/pricey', headers);

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ credits: { price: '0.05' } });
  });

  it('answers two credentials with 400 multiple_payment_methods, holding nothing and calling no upstream', async () => {
    const [seller, buyer] = [await newSeller(), await newBuyer()];
    const before = upstreamCalls();

    const response = await call(seller, '/weather/oslo', paid(buyer, { 'x-payment': 'eyJ4NDAyVmVyc2lvbiI6MX0' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'multiple_payment_methods' } });
    expect(upstreamCalls()).toBe(before);
    expect(await paymentsOf(buyer)).toEqual([]);
  });

  it('answers a master key with 401 wrong_key_type and WWW-Authenticate: Bearer (AK-4)', async () => {
    const [seller, buyer] = [await newSeller(), await newBuyer()];

    const response = await call(seller, '/weather/oslo', { authorization: `Bearer ${buyer.masterKey}` });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(await response.json()).toMatchObject({ error: { code: 'wrong_key_type' } });
    expect(await paymentsOf(buyer)).toEqual([]);
  });

  it.each([
    ['an unknown payment key', () => `sr_test_${'Z'.repeat(43)}`],
    ['a malformed one', () => 'sr_test_short'],
  ])('answers %s with 401 invalid_key', async (_case, key) => {
    const seller = await newSeller();

    const response = await call(seller, '/weather/oslo', { authorization: `Bearer ${key()}` });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_key' } });
  });

  it('refuses a price above the key\'s maximum with 402 key_price_limit, and an expired key with 401 invalid_key (AK-6)', async () => {
    const seller = await newSeller();
    const [capped, expiring] = [await newBuyer({ limits: { maxPrice: '0.01' } }), await newBuyer()];
    await database.db.execute(sql`update api_keys set expires_at = now() - interval '1 second' where id = ${expiring.keyId}`);

    const [pricey, cheap, expired] = [
      await call(seller, '/pricey', paid(capped)),
      await call(seller, '/weather/oslo', paid(capped)),
      await call(seller, '/weather/oslo', paid(expiring)),
    ];

    expect(pricey.status).toBe(402);
    expect(await pricey.json()).toMatchObject({ error: { code: 'key_price_limit' } });
    expect(pricey.headers.get('cache-control')).toBe('no-store');
    expect(cheap.status).toBe(200);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: { code: 'invalid_key' } });
  });
});

describe('key changes reach the proxy at once (AK-9)', () => {
  const keyEvents = () => metricValue('proxy_invalidation_events_total{kind="key"}');

  it('stops a revoked key on the next request, without waiting for the cache TTL', async () => {
    const [seller, buyer] = [await newSeller(), await newBuyer()];
    expect((await call(seller, '/weather/oslo', paid(buyer))).status).toBe(200);
    const before = await keyEvents();

    await apiCall(buyer, 'DELETE', `/v1/keys/${buyer.keyId}`);
    await vi.waitFor(async () => expect(await keyEvents()).toBeGreaterThan(before));
    const response = await call(seller, '/weather/oslo', paid(buyer));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_key' } });
  });

  it('applies a lower maximum price on the next request', async () => {
    const [seller, buyer] = [await newSeller(), await newBuyer()];
    expect((await call(seller, '/pricey', paid(buyer))).status).toBe(200);
    const before = await keyEvents();

    await apiCall(buyer, 'PATCH', `/v1/keys/${buyer.keyId}`, { maxPrice: '0.01' });
    await vi.waitFor(async () => expect(await keyEvents()).toBeGreaterThan(before));

    expect((await call(seller, '/pricey', paid(buyer))).status).toBe(402);
  });
});

describe('the buyer header (PX-15)', () => {
  const buyerSeen = async (response: Response) => (await response.json() as { buyer: string | null }).buyer;

  it('tells the upstream who pays without saying who: stable per buyer and service, different across services and buyers', async () => {
    const [first, second] = [await newSeller(), await newSeller()];
    const [alice, bob] = [await newBuyer(), await newBuyer()];
    const expected = createBuyerHeaderValue(Secret.from(buyerHeaderKey));

    const seen = [
      await buyerSeen(await call(first, '/weather/oslo', paid(alice))),
      await buyerSeen(await call(first, '/weather/oslo', paid(alice))),
      await buyerSeen(await call(second, '/weather/oslo', paid(alice))),
      await buyerSeen(await call(first, '/weather/oslo', paid(bob))),
    ];

    expect(seen[0]).toBe(expected(`account:${alice.id}`, first.serviceId));
    expect(seen[1]).toBe(seen[0]);
    expect(new Set(seen).size).toBe(3);
    expect(seen.join(',')).not.toContain(alice.id);
  });

  it('never passes a client\'s own Servicerouter-Buyer (PX-5)', async () => {
    const [seller, buyer] = [await newSeller(), await newBuyer()];

    const [paidCall, freeCall] = [
      await call(seller, '/weather/oslo', paid(buyer, { 'servicerouter-buyer': 'forged' })),
      await call(seller, '/free', { 'servicerouter-buyer': 'forged' }),
    ];

    expect(await buyerSeen(paidCall)).not.toBe('forged');
    expect(await buyerSeen(freeCall)).toBeNull();
  });
});

describe('rate limits (PX-13)', () => {
  const retried = async (response: Response) => ({
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    code: (await response.json() as { error?: { code: string } }).error?.code,
  });

  it('limits unpaid requests that only get a 402 per client IP, with 429 and Retry-After', async () => {
    const seller = await newSeller();

    const answers = [
      await call(seller, '/weather/oslo', {}, limitedUrl),
      await call(seller, '/weather/oslo', {}, limitedUrl),
      await call(seller, '/weather/oslo', {}, limitedUrl),
    ];

    expect(answers.map(answer => answer.status)).toEqual([402, 402, 429]);
    expect(await retried(answers[2]!)).toEqual({ status: 429, retryAfter: expect.stringMatching(/^\d+$/), code: 'rate_limited' });
    expect(Number(answers[2]!.headers.get('retry-after'))).toBeLessThanOrEqual(30);
  });

  it('limits each payment key, and each service across keys', async () => {
    const [byKey, byService] = [await newSeller(), await newSeller()];
    const [heavy, first, second] = [await newBuyer(), await newBuyer(), await newBuyer()];

    const keyAnswers = [
      await call(byKey, '/weather/oslo', paid(heavy), limitedUrl),
      await call(byKey, '/weather/oslo', paid(heavy), limitedUrl),
      await call(byKey, '/weather/oslo', paid(heavy), limitedUrl),
    ];
    const serviceAnswers = [
      await call(byService, '/weather/oslo', paid(first), limitedUrl),
      await call(byService, '/weather/oslo', paid(first), limitedUrl),
      await call(byService, '/weather/oslo', paid(second), limitedUrl),
      await call(byService, '/weather/oslo', paid(second), limitedUrl),
    ];

    expect(keyAnswers.map(answer => answer.status)).toEqual([200, 200, 429]);
    expect(serviceAnswers.map(answer => answer.status)).toEqual([200, 200, 200, 429]);
    expect(await retried(serviceAnswers[3]!)).toMatchObject({ code: 'rate_limited', retryAfter: expect.stringMatching(/^\d+$/) });
    // A limited call holds nothing
    expect((await paymentsOf(heavy)).length).toBe(2);
  });
});

describe('GET /_/key (AK-8)', () => {
  it('shows the key\'s limits and what\'s left of the allowance, today\'s budget, and the balance', async () => {
    const [seller, buyer] = [await newSeller(), await newBuyer({ credit: '5', limits: { label: 'n8n', allowance: '2', dailyBudget: '1', maxPrice: '0.05' } })];
    const requestId = nextRequestId('key');
    await (await call(seller, '/weather/oslo', paid(buyer, { 'x-request-id': requestId }))).arrayBuffer();
    await settled(requestId);

    const response = await fetch(`${proxyUrl}/_/key`, { headers: paid(buyer) });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      id: buyer.keyId,
      label: 'n8n',
      allowance: '2',
      dailyBudget: '1',
      maxPrice: '0.05',
      expiresAt: null,
      createdAt: expect.any(String),
      spent: { today: '0.001', total: '0.001' },
      remaining: { allowance: '1.999', dailyBudget: '0.999', balance: '4.999' },
    });
  });

  it.each([
    ['without a key', () => ({}), 'unauthorized'],
    ['with a master key', (buyer: Buyer) => ({ authorization: `Bearer ${buyer.masterKey}` }), 'wrong_key_type'],
    ['with an unknown key', () => ({ authorization: `Bearer sr_test_${'Y'.repeat(43)}` }), 'invalid_key'],
  ])('answers %s with 401', async (_case, headers, code) => {
    const buyer = await newBuyer({ credit: '0' });

    const response = await fetch(`${proxyUrl}/_/key`, { headers: headers(buyer) });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(await response.json()).toMatchObject({ error: { code } });
  });
});
