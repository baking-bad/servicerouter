import { generateKeyPairSigner } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { sql } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp as createApi, type ApiServer } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp, Secret, type ServiceId } from '@servicerouter/common';
import { assumeHostsVerified, facilitatorFee, loadPlatformConfig, type Payment, type PlatformConfig } from '@servicerouter/core';
import { createLedger, createPaymentRepository, ledgerAccountIds } from '@servicerouter/db';
import { createAssetLookup, createFacilitatorLookup, createFacilitators, initializeX402, type X402Setup } from '@servicerouter/payments';
import {
  createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, encodeBase58, facilitatorAnswers, startFakeFacilitator,
  startFakeSolanaRpc, startFakeUpstream, type FakeFacilitator, type FakeSolanaRpc, type FakeUpstream, type TestDatabase, type TestRedis,
  type TestSecretKeys,
} from '@servicerouter/testing';
import { createSettlementFollowUp } from '@servicerouter/workers';

import { createApp, type ProxyServer } from '../../src/app.js';

// P-2: the platform's flat fee on each x402 payment a facilitator with `feePerPayment` settles, from the
// seller's earnings. Here `cdp` settles Base with a $0.0005 fee, and `plain` settles Solana without one.

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const generous = { requests: 100_000, windowSeconds: 60 };
const clock = { now: () => new Date() };
const logger = createLogger({ level: 'silent' });

const openapi = {
  openapi: '3.1.0',
  info: { title: 'Weather', version: '1.0.0' },
  paths: {
    '/weather/{city}': { get: { operationId: 'getWeather', summary: 'Current weather', responses: { 200: { description: 'OK' } } } },
    '/cheap': { get: { operationId: 'getCheap', responses: { 200: { description: 'OK' } } } },
    '/pricey': { get: { operationId: 'getPricey', responses: { 200: { description: 'OK' } } } },
  },
};

let database: TestDatabase;
let redis: TestRedis;
let keys: TestSecretKeys;
let upstream: FakeUpstream;
let cdp: FakeFacilitator;
let plain: FakeFacilitator;
let rpc: FakeSolanaRpc;
let config: PlatformConfig;
let setup: X402Setup;
let apiHttp: OutboundHttp;
let proxyHttp: OutboundHttp;
let api: ApiServer;
// feeBps 0, as production: the flat fee alone
let proxy: ProxyServer;
// feeBps 1000: the flat fee on top of a percentage
let percentProxy: ProxyServer;
let apiUrl: string;
let internalUrl: string;
let proxyUrl: string;
let percentUrl: string;
let counter = 0;

const loadConfig = (feeBps: number) => loadPlatformConfig({
  env: {
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: Buffer.from(JSON.stringify({
      feeBps,
      rateLimits: { signup: generous, paymentKey: generous, service: generous, unpaidIp: generous },
      facilitators: [
        { name: 'cdp', url: cdp.url, networks: [base], feePerPayment: '0.0005' },
        { name: 'plain', url: plain.url, networks: [solana] },
        { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:preprod'], enabled: false },
      ],
      mpp: { enabled: false },
    })).toString('base64'),
  },
});

const x402Of = (platform: PlatformConfig) =>
  initializeX402({ config: platform, facilitators: createFacilitators({ config: platform, cdpApiKey: () => { throw new Error('No CDP auth here'); }, clock }), timeoutMs: 5_000 });

beforeAll(async () => {
  [database, redis, keys, upstream, cdp, plain, rpc] = await Promise.all([
    createTestDatabase(),
    createTestRedis(),
    createTestSecretKeys(),
    startFakeUpstream({ hosts: ['api.example.com'] }),
    startFakeFacilitator({ networks: [base] }),
    startFakeFacilitator({ networks: [solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }),
    startFakeSolanaRpc(),
  ]);
  const percentConfig = await loadConfig(1_000);
  config = await loadConfig(0);
  upstream.handle((request, response) => {
    if (request.path.split('?')[0] === '/openapi.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(openapi));
    }
    else
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: request.path }));
  });
  const resolver = createFakeResolver({ 'api.example.com': '127.0.0.1' });
  const outbound = { ownHosts: config.ownHosts, resolver, addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }), ca: upstream.ca };
  apiHttp = new OutboundHttp({ ...outbound, connectTimeoutMs: 5_000 });
  proxyHttp = new OutboundHttp({
    ...outbound, connectTimeoutMs: 5_000, totalTimeoutMs: 5_000, maxRequestBytes: config.sizeLimits.requestBodyBytes, maxResponseBytes: 1_048_576,
  });
  const percentSetup = await x402Of(percentConfig);
  setup = await x402Of(config);

  api = createApi({ config, logger, postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: apiHttp, ownership: assumeHostsVerified, internalSecret: Secret.from(internalSecret) });
  const dependencies = { logger, postgres: database.postgres, redis, opener: keys.opener, http: proxyHttp, buyerHeaderKey: Secret.from('buyer-header-key-for-the-flat-fee-tests') };
  proxy = createApp({ ...dependencies, config, x402: setup });
  percentProxy = createApp({ ...dependencies, config: percentConfig, x402: percentSetup });
  const listen = { host: '127.0.0.1', port: 0, metricsPort: 0 };
  const [apiPorts, proxyPorts, percentPorts] = await Promise.all([api.listen({ ...listen, internalPort: 0 }), proxy.listen(listen), percentProxy.listen(listen)]);
  apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  internalUrl = `http://127.0.0.1:${apiPorts.internalPort!}`;
  proxyUrl = `http://127.0.0.1:${proxyPorts.port}`;
  percentUrl = `http://127.0.0.1:${percentPorts.port}`;
  await Promise.all([proxy.subscribed, percentProxy.subscribed]);
});

afterAll(async () => {
  await Promise.all([api?.close(), proxy?.close(), percentProxy?.close()]);
  await Promise.all([apiHttp?.close(), proxyHttp?.close(), upstream?.close(), cdp?.close(), plain?.close(), rpc?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

beforeEach(() => {
  cdp.reset();
  plain.reset();
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
  getCheap:
    payment:
      amount: "0.0003"
  getPricey:
    payment:
      amount: "0.01"

credentials:
  main-key:
    type: http
    scheme: bearer
    secret: weather-key
`;

interface Seller extends Account {
  readonly serviceId: ServiceId;
}

/** A seller with a live service of its own, so its earnings count only the test's calls: $0.001 a call, `/cheap` $0.0003, `/pricey` $0.01. */
const newSeller = async (): Promise<Seller> => {
  counter += 1;
  const seller = await signup();
  const serviceId = `flat-fee-${counter}` as ServiceId;
  const submitted = await apiCall(seller, 'PUT', `/v1/services/${serviceId}`, { config: serviceYaml(serviceId), secrets: { 'weather-key': `sk-${counter}` } });
  if (submitted.status >= 300)
    throw new Error(`Submit failed: ${JSON.stringify(submitted.body)}`);

  return { ...seller, serviceId };
};

const buyer = privateKeyToAccount(generatePrivateKey());

/** An x402 call paid on `network`, signed by the official client for the 402's option there. */
const paidCall = async (seller: Seller, path: string, { network = base, at = proxyUrl } = {}): Promise<{ readonly response: Response; readonly requestId: string }> => {
  const unpaid = await fetch(`${at}/service/${seller.serviceId}${path}`);
  const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);
  const client = new x402Client()
    .register(base, new ExactEvmScheme(buyer))
    .register(solana, new ExactSvmScheme(await generateKeyPairSigner(), { rpcUrl: rpc.url }));
  const signature = encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === network) }));
  counter += 1;
  const requestId = `flat-fee-${counter}`;
  const response = await fetch(`${at}/service/${seller.serviceId}${path}`, { headers: { 'payment-signature': signature, 'x-request-id': requestId } });
  await response.arrayBuffer();

  return { response, requestId };
};

const paymentFor = async (requestId: string): Promise<Payment | undefined> => {
  const { rows } = await database.db.execute<{ id: string }>(sql`select id from payments where request_id = ${requestId}`);

  return rows[0] ? createPaymentRepository({ db: database.db, clock }).find(rows[0].id) : undefined;
};

/** Waits until finalize, which runs once the response is out, has finished the payment. */
const finished = async (requestId: string): Promise<Payment> => {
  let payment: Payment | undefined;
  await vi.waitFor(async () => {
    payment = await paymentFor(requestId);
    expect(payment?.status).toMatch(/^(captured|settled)$/);
  });

  return payment!;
};

const earnings = async (seller: Seller) => (await apiCall(seller, 'GET', `/v1/services/${seller.serviceId}/earnings`)).body;

const ledger = () => createLedger({ db: database.db, clock, ids: { next: () => crypto.randomUUID() } });

const balancesOf = async (seller: Seller) => {
  const found = await ledger().balancesOf([ledgerAccountIds.earned(seller.id), ledgerAccountIds.fees]);

  return { earned: found.get(ledgerAccountIds.earned(seller.id)) ?? 0n, fees: found.get(ledgerAccountIds.fees) ?? 0n };
};

const followUp = () => createSettlementFollowUp({
  payments: createPaymentRepository({ db: database.db, clock }),
  ledger: ledger(),
  facilitatorFor: createFacilitatorLookup(config, setup.facilitators),
  assetName: createAssetLookup(config),
  feeBps: config.feeBps,
  feePerPayment: network => facilitatorFee(config, network),
  logger,
})();

// --- Tests ---

describe('the flat fee on x402 payments a facilitator settles (P-2, LG-4, LG-10)', () => {
  it('takes $0.0005 of a $0.001 call through CDP for the platform, and the seller earns $0.0005', async () => {
    const seller = await newSeller();
    const before = await balancesOf(seller);

    const { response, requestId } = await paidCall(seller, '/weather/oslo');

    expect(response.status).toBe(200);
    expect(await finished(requestId)).toMatchObject({ status: 'settled', rail: 'x402', network: base, amount: 1_000n, fee: 500n });
    const after = await balancesOf(seller);
    expect(after.earned - before.earned).toBe(500n);
    expect(after.fees - before.fees).toBe(500n);
    // The earnings endpoint keeps its shape: its fee includes the flat fee
    expect(await earnings(seller)).toMatchObject({ calls: 1, earned: { total: '0.0005', byRail: { x402: '0.0005' } }, fee: '0.0005', pending: '0.0005' });
  });

  it('caps the fee at a $0.0003 call\'s price: the platform takes $0.0003, and the seller earns 0, never less', async () => {
    const seller = await newSeller();
    const before = await balancesOf(seller);

    const { response, requestId } = await paidCall(seller, '/cheap');

    expect(response.status).toBe(200);
    expect(await finished(requestId)).toMatchObject({ status: 'settled', amount: 300n, fee: 300n });
    const after = await balancesOf(seller);
    expect(after.earned).toBe(0n);
    expect(after.fees - before.fees).toBe(300n);
    expect(await earnings(seller)).toMatchObject({ calls: 1, earned: { total: '0', byRail: { x402: '0' } }, fee: '0.0003', pending: '0' });
  });

  it('adds the flat fee to feeBps\'s share: $0.0015 on a $0.01 call at 1000 bps', async () => {
    const seller = await newSeller();

    const { response, requestId } = await paidCall(seller, '/pricey', { at: percentUrl });

    expect(response.status).toBe(200);
    expect(await finished(requestId)).toMatchObject({ status: 'settled', amount: 10_000n, fee: 1_500n });
    expect(await earnings(seller)).toMatchObject({ earned: { total: '0.0085' }, fee: '0.0015' });
  });

  it('takes no flat fee on credits, or on x402 through a facilitator without one', async () => {
    const seller = await newSeller();
    const paying = await signup();
    const key = await apiCall(paying, 'POST', '/v1/keys', { dailyBudget: '1' });
    counter += 1;
    const credited = await fetch(`${internalUrl}/internal/v1/accounts/${paying.id}/credits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': internalSecret },
      body: JSON.stringify({ amount: '1', reference: `flat-fee-credit-${counter}` }),
    });
    expect(credited.status).toBe(201);
    counter += 1;
    const creditsRequestId = `flat-fee-credits-${counter}`;

    const credits = await fetch(`${proxyUrl}/service/${seller.serviceId}/weather/oslo`, { headers: { authorization: `Bearer ${key.body['key'] as string}`, 'x-request-id': creditsRequestId } });
    await credits.arrayBuffer();
    const onSolana = await paidCall(seller, '/weather/oslo', { network: solana });

    expect(credits.status).toBe(200);
    expect(onSolana.response.status).toBe(200);
    expect(await finished(creditsRequestId)).toMatchObject({ status: 'captured', rail: 'credits', amount: 1_000n, fee: 0n });
    expect(await finished(onSolana.requestId)).toMatchObject({ status: 'settled', rail: 'x402', network: solana, amount: 1_000n, fee: 0n });
    expect(await earnings(seller)).toMatchObject({ calls: 2, earned: { total: '0.002', byRail: { credits: '0.001', x402: '0.001' } }, fee: '0' });
  });

  it('books the same fee on a settlement the follow-up finishes as on one the proxy finishes (WK-6, PR-12)', async () => {
    const seller = await newSeller();
    const atOnce = await paidCall(seller, '/weather/oslo');
    cdp.handle('/settle', facilitatorAnswers.pending('0xflatfee0001'));
    const later = await paidCall(seller, '/weather/bergen');

    expect(later.response.status).toBe(200);
    expect(await paymentFor(later.requestId)).toMatchObject({ status: 'settling', fee: undefined });
    cdp.reset();
    expect(await followUp()).toMatchObject({ settled: 1 });

    const proxyFinished = await finished(atOnce.requestId);
    const followedUp = await finished(later.requestId);
    expect(followedUp).toMatchObject({ status: 'settled', amount: 1_000n, fee: 500n, needsReview: false });
    expect(followedUp.fee).toBe(proxyFinished.fee);
    expect(await earnings(seller)).toMatchObject({ calls: 2, earned: { total: '0.001' }, fee: '0.001' });
  });
});
