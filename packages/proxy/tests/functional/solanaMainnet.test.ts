import { generateKeyPairSigner } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp as createApi, type ApiServer } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp, Secret, type ServiceId } from '@servicerouter/common';
import { assumeHostsVerified, loadPlatformConfig, type Payment, type PlatformConfig } from '@servicerouter/core';
import { createLedger, createPaymentRepository, ledgerAccountIds } from '@servicerouter/db';
import { createFacilitators, initializeX402 } from '@servicerouter/payments';
import {
  createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, encodeBase58, startFakeFacilitator, startFakeSolanaRpc,
  startFakeUpstream, type FakeFacilitator, type FakeSolanaRpc, type FakeUpstream, type TestDatabase, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createApp, type ProxyServer } from '../../src/app.js';

// P-6 (owner, 2026-10-06T19:50:00+08:00): buyers pay with USDC on Solana mainnet through CDP, on config/production.yaml
// with its treasury addresses filled in and CDP faked. CDP's fee payer pays the network fee.

const base = 'eip155:8453';
const solana = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const solanaUsdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const solanaTreasury = '4SHMcqadX3DViKFermsfRSzGVSF7XLMpZWyJanK1PWKX';
const feePayer = encodeBase58(Uint8Array.from({ length: 32 }, () => 7));
const generous = { requests: 100_000, windowSeconds: 60 };
const clock = { now: () => new Date() };
const logger = createLogger({ level: 'silent' });

const openapi = {
  openapi: '3.1.0',
  info: { title: 'Weather', version: '1.0.0' },
  paths: { '/weather/{city}': { get: { operationId: 'getWeather', summary: 'Current weather', responses: { 200: { description: 'OK' } } } } },
};

let database: TestDatabase;
let redis: TestRedis;
let keys: TestSecretKeys;
let upstream: FakeUpstream;
let cdp: FakeFacilitator;
let rpc: FakeSolanaRpc;
let config: PlatformConfig;
let apiHttp: OutboundHttp;
let proxyHttp: OutboundHttp;
let api: ApiServer;
let proxy: ProxyServer;
let apiUrl: string;
let proxyUrl: string;
let counter = 0;

/** config/production.yaml with sample treasuries where it still has placeholders, CDP faked, and Cardano and MPP off. */
const loadConfig = () => loadPlatformConfig({
  env: {
    CONFIG_PATH: 'config/production.yaml',
    CONFIG: Buffer.from(JSON.stringify({
      assets: [
        { name: 'base-usdc', network: base, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, peg: 'usd', payTo: '0x1111111111111111111111111111111111111111' },
        { name: 'solana-usdc', network: solana, address: solanaUsdc, decimals: 6, peg: 'usd', payTo: solanaTreasury },
        {
          name: 'cardano-usdm', network: 'cardano:mainnet', address: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d', decimals: 6, peg: 'usd',
          payTo: 'addr1v9zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q09h6pt',
        },
        { name: 'tempo-usdce', network: 'eip155:4217', address: '0x20C000000000000000000000b9537d11c60E8b50', decimals: 6, peg: 'usd', payTo: '0x2222222222222222222222222222222222222222' },
      ],
      rateLimits: { signup: generous, paymentKey: generous, service: generous, unpaidIp: generous },
      facilitators: [
        { name: 'cdp', url: cdp.url, networks: [base, solana], feePerPayment: '0.0005' },
        { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:mainnet'], enabled: false },
      ],
      mpp: { enabled: false, recipient: '0x2222222222222222222222222222222222222222' },
    })).toString('base64'),
  },
});

beforeAll(async () => {
  [database, redis, keys, upstream, cdp, rpc] = await Promise.all([
    createTestDatabase(),
    createTestRedis(),
    createTestSecretKeys(),
    startFakeUpstream({ hosts: ['api.example.com'] }),
    startFakeFacilitator({ networks: [base, solana], feePayer }),
    startFakeSolanaRpc(),
  ]);
  config = await loadConfig();
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
  const setup = await initializeX402({
    config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth here'); }, clock }), timeoutMs: 5_000,
  });

  api = createApi({
    config, logger, postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: apiHttp, ownership: assumeHostsVerified, internalSecret: Secret.from('internal-secret-0123456789abcdef-xyz'),
  });
  proxy = createApp({ config, x402: setup, logger, postgres: database.postgres, redis, opener: keys.opener, http: proxyHttp, buyerHeaderKey: Secret.from('buyer-header-key-for-the-solana-tests') });
  const listen = { host: '127.0.0.1', port: 0, metricsPort: 0 };
  const [apiPorts, proxyPorts] = await Promise.all([api.listen({ ...listen, internalPort: 0 }), proxy.listen(listen)]);
  apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  proxyUrl = `http://127.0.0.1:${proxyPorts.port}`;
  await proxy.subscribed;
});

afterAll(async () => {
  await Promise.all([api?.close(), proxy?.close()]);
  await Promise.all([apiHttp?.close(), proxyHttp?.close(), upstream?.close(), cdp?.close(), rpc?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// --- Helpers ---

interface Seller {
  readonly id: string;
  readonly masterKey: string;
  readonly serviceId: ServiceId;
}

const serviceYaml = (id: string) => `servicerouter:
  version: "1"

service:
  id: ${id}
  title: Weather
  description: Weather forecasts.
  category: data/geo

payouts:
  default:
    asset: cardano-usdm
    address: addr1v9zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q09h6pt

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

/** A seller with a live $0.001 service of its own, so its earnings count only the test's calls. */
const newSeller = async (): Promise<Seller> => {
  counter += 1;
  const account = await (await fetch(`${apiUrl}/v1/accounts`, { method: 'POST' })).json() as { id: string; masterKey: string };
  const serviceId = `solana-${counter}` as ServiceId;
  const submitted = await fetch(`${apiUrl}/v1/services/${serviceId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${account.masterKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ config: serviceYaml(serviceId), secrets: { 'weather-key': `sk-${counter}` } }),
  });
  if (submitted.status >= 300)
    throw new Error(`Submit failed: ${await submitted.text()}`);

  return { ...account, serviceId };
};

/** Waits until finalize, which runs once the response is out, has finished the payment. */
const finished = async (requestId: string): Promise<Payment> => {
  let payment: Payment | undefined;
  await vi.waitFor(async () => {
    const { rows } = await database.db.execute<{ id: string }>(sql`select id from payments where request_id = ${requestId}`);
    payment = rows[0] ? await createPaymentRepository({ db: database.db, clock }).find(rows[0].id) : undefined;
    expect(payment?.status).toBe('settled');
  });

  return payment!;
};

// --- Tests ---

describe('x402 on Solana mainnet through CDP, on the production config (PR-5, PR-6, PC-6, P-6)', () => {
  it('offers USDC on Solana in the combined 402: the mainnet mint, the Solana treasury, and CDP\'s fee payer', async () => {
    const seller = await newSeller();

    const unpaid = await fetch(`${proxyUrl}/service/${seller.serviceId}/weather/oslo`);
    await unpaid.arrayBuffer();

    expect(unpaid.status).toBe(402);
    const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);
    expect(required.accepts.map(option => option.network)).toEqual([base, solana]);
    expect(required.accepts.find(option => option.network === solana)).toMatchObject({
      scheme: 'exact', asset: solanaUsdc, amount: '1000', payTo: solanaTreasury, extra: { feePayer },
    });
  });

  it('takes a payment signed by @x402/svm on Solana mainnet: 200, settled through CDP, and the seller earns the price minus $0.0005', async () => {
    const seller = await newSeller();
    const unpaid = await fetch(`${proxyUrl}/service/${seller.serviceId}/weather/oslo`);
    await unpaid.arrayBuffer();
    const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);
    const client = new x402Client().register(solana, new ExactSvmScheme(await generateKeyPairSigner(), { rpcUrl: rpc.url }));
    const signature = encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === solana) }));
    counter += 1;
    const requestId = `solana-mainnet-${counter}`;

    const response = await fetch(`${proxyUrl}/service/${seller.serviceId}/weather/oslo`, { headers: { 'payment-signature': signature, 'x-request-id': requestId } });
    await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(await finished(requestId)).toMatchObject({ status: 'settled', rail: 'x402', network: solana, amount: 1_000n, fee: 500n });
    expect(cdp.requests.filter(request => request.path === '/settle').at(-1)?.body).toMatchObject({ paymentRequirements: { network: solana, payTo: solanaTreasury } });
    const ledger = createLedger({ db: database.db, clock, ids: { next: () => crypto.randomUUID() } });
    const balances = await ledger.balancesOf([ledgerAccountIds.earned(seller.id), ledgerAccountIds.treasury('solana-usdc')]);
    expect(balances.get(ledgerAccountIds.earned(seller.id))).toBe(500n);
    // What came in on Solana sits in its treasury: the ledger's view of it goes down by the price (TR-5)
    expect(balances.get(ledgerAccountIds.treasury('solana-usdc'))).toBe(-1_000n);
  });
});
