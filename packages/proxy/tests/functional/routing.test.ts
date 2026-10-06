import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { Registry } from '@prometheus-io/client';
import { eq } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp as createApi, type ApiServer } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp, randomIdGenerator, Secret, type Server } from '@servicerouter/common';
import { assumeHostsVerified, findAsset, loadPlatformConfig, type PlatformConfig } from '@servicerouter/core';
import { createLedger, createRoutingRepository, ledgerAccountIds, payments, routedEndpoints, signatures, targetPayments } from '@servicerouter/db';
import { createFacilitators, initializeX402 } from '@servicerouter/payments';
import { createApp as createSigner } from '@servicerouter/signer';
import { createRoutingLossMetrics, createRoutingLosses } from '@servicerouter/workers';
import {
  createFakeOwnershipFiles, createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, encodeBase58, startFakeFacilitator,
  startFakeUpstream, type FakeFacilitator, type FakeOwnershipFiles, type FakeUpstream, type TestDatabase, type TestRedis,
} from '@servicerouter/testing';

import { createApp, type ProxyServer } from '../../src/app.js';
import { createSignerClient } from '../../src/routing/support.js';

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const signerSecret = 'signer-secret-0123456789abcdef-0123456789';
const targetHosts = ['api.target.dev', 'optout.target.dev', 'blocked.target.dev'];
const targetPayTo = '0x1111111111111111111111111111111111111111';
const generous = { requests: 100_000, windowSeconds: 60 };

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let target: FakeUpstream;
let files: FakeOwnershipFiles;
let facilitator: FakeFacilitator;
let http: OutboundHttp;
let api: ApiServer;
let proxy: ProxyServer;
let signer: Server;
let apiUrl: string;
let internalUrl: string;
let proxyUrl: string;
let usdc: string;
const signerKey = generatePrivateKey();
const signerWallet = privateKeyToAccount(signerKey);
const paidRequests: { path: string; amount: string; to: string }[] = [];
// The PAYMENT-SIGNATURE values the target received: none may reach a log
const signedHeaders: string[] = [];
// Every line the three apps write, debug included, each with its app's name
const lines: Record<string, unknown>[] = [];
const loggerFor = (name: string) => createLogger({ name, level: 'debug' }, {
  write: (line: string) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
    if (process.env['ROUTING_LOGS'])
      process.stdout.write(line);
  },
});

/** The target's x402 options: a Gateway nanopayment, cheaper, and a plain USDC payment on Base. */
const options = (amount: string): PaymentRequirements[] => [
  { scheme: 'exact', network: base, amount: '100', asset: usdc, payTo: targetPayTo, maxTimeoutSeconds: 60, extra: { name: 'GatewayWalletBatched', version: '1' } },
  { scheme: 'exact', network: base, amount, asset: usdc, payTo: targetPayTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } },
] as PaymentRequirements[];

const challenge = (url: string, amount: string) => encodePaymentRequiredHeader({
  x402Version: 2, error: 'Payment required', resource: { url, description: 'Pools', mimeType: 'application/json' }, accepts: options(amount),
} as never);

beforeAll(async () => {
  [database, redis, target, facilitator] = await Promise.all([
    createTestDatabase(), createTestRedis(), startFakeUpstream({ hosts: targetHosts }), startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }),
  ]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        // A 10% routing fee, so the split shows
        routingFeeBps: 1000,
        rateLimits: { signup: generous, paymentKey: generous, service: generous, unpaidIp: generous },
        facilitators: [
          { name: 'cdp', url: facilitator.url, networks: [base, solana] },
          { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:preprod'], enabled: false },
        ],
        mpp: { enabled: false },
        signer: { maxPerCall: '0.5', maxPerNetworkPerDay: '100' },
      })).toString('base64'),
    },
  });
  usdc = findAsset(config, 'base-usdc')!.address;
  files = createFakeOwnershipFiles();
  files.publish('optout.target.dev', { version: 1, verification: [], routing: false });
  target.handle((request, response) => {
    if (files.handle(request, response))
      return;
    const path = request.path.split('?')[0]!;
    const url = `https://${request.servername}:${target.port}${path}`;
    if (path === '/v1/free') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"free":true}');
      return;
    }
    if (path === '/v1/gateway-only') {
      const gatewayOnly = encodePaymentRequiredHeader({
        x402Version: 2, error: 'Payment required', resource: { url, description: 'Gateway only', mimeType: 'application/json' }, accepts: options('1000').slice(0, 1),
      } as never);
      response.writeHead(402, { 'payment-required': gatewayOnly }).end('{}');
      return;
    }
    const header = request.headers['payment-signature'];
    if (typeof header !== 'string') {
      response.writeHead(402, { 'payment-required': challenge(url, path === '/v1/expensive' ? '600000' : '1000'), 'content-type': 'application/json' }).end('{}');
      return;
    }
    signedHeaders.push(header);
    const payload = decodePaymentSignatureHeader(header) as unknown as { accepted: PaymentRequirements; payload: { authorization: { to: string; value: string } } };
    paidRequests.push({ path, amount: payload.payload.authorization.value, to: payload.payload.authorization.to });
    if (path === '/v1/pricier') {
      response.writeHead(402, { 'payment-required': challenge(url, '5000') }).end('{}');
      return;
    }
    const settled = encodePaymentResponseHeader({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: base, payer: signerWallet.address } as never);
    if (path === '/v1/broken') {
      response.writeHead(500, { 'payment-response': settled }).end('{"error":"boom"}');
      return;
    }
    // A target that names its own requests (L-2)
    response.writeHead(200, {
      'content-type': 'application/json', 'payment-response': settled, location: `https://${request.servername}:${target.port}/v1/pools/next`,
      ...path === '/v1/traced' ? { 'x-request-id': 'target-request-7' } : {},
    }).end(JSON.stringify({ pools: [1, 2, 3], path }));
  });
  http = new OutboundHttp({
    ownHosts: config.ownHosts,
    resolver: createFakeResolver(Object.fromEntries(targetHosts.map(host => [host, '127.0.0.1']))),
    addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: target.ca,
    connectTimeoutMs: 5_000,
    totalTimeoutMs: 5_000,
  });
  const keys = await createTestSecretKeys();
  signer = createSigner({ config, logger: loggerFor('signer'), postgres: database.postgres, redis, secret: Secret.from(signerSecret), wallets: { base: signerWallet } });
  api = createApi({ config, logger: loggerFor('api'), postgres: database.postgres, redis, sealer: keys.sealer, ownership: assumeHostsVerified, internalSecret: Secret.from(internalSecret) });
  const [signerPorts, apiPorts] = await Promise.all([
    signer.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 }),
    api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 }),
  ]);
  apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  internalUrl = `http://127.0.0.1:${apiPorts.internalPort!}`;
  const x402 = await initializeX402({ config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth'); }, clock: { now: () => new Date() } }), timeoutMs: 5_000 });
  proxy = createApp({
    config, logger: loggerFor('proxy'), postgres: database.postgres, redis, opener: keys.opener, http, buyerHeaderKey: Secret.from('buyer-header-key-for-the-routing-tests'), x402,
    signer: createSignerClient({ url: `http://127.0.0.1:${signerPorts.port}`, secret: Secret.from(signerSecret), timeoutMs: 5_000 }),
    internalApi: { url: internalUrl, secret: Secret.from(internalSecret) },
    ownershipFileUrl: host => target.url(host, '/.well-known/servicerouter.json'),
  });
  proxyUrl = `http://127.0.0.1:${(await proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
});

afterAll(async () => {
  await Promise.all([api?.close(), proxy?.close(), signer?.close()]);
  await Promise.all([http?.close(), target?.close(), facilitator?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// The fake target listens on a port of its own: links name it, as /<host>:<port>/… allows (RT-1)
const at = (host: string): string => `${host}:${target.port}`;

/** A buyer with credits and a payment key. */
const buyer = async (credit = '1') => {
  const account = await (await fetch(`${apiUrl}/v1/accounts`, { method: 'POST' })).json() as { id: string; masterKey: string };
  const { key } = await (await fetch(`${apiUrl}/v1/keys`, {
    method: 'POST', headers: { authorization: `Bearer ${account.masterKey}`, 'content-type': 'application/json' }, body: '{}',
  })).json() as { key: string };
  await fetch(`${internalUrl}/internal/v1/accounts/${account.id}/credits`, {
    method: 'POST', headers: { 'x-internal-secret': internalSecret, 'content-type': 'application/json' }, body: JSON.stringify({ amount: credit, reference: `credit-${account.id}` }),
  });

  return { ...account, key };
};

const balance = async (accountId: string): Promise<bigint> => (await createLedger({ db: database.db, clock: { now: () => new Date() }, ids: randomIdGenerator }).balance(accountId)).available;
const platformBalances = async () => Object.fromEntries(await createLedger({ db: database.db, clock: { now: () => new Date() }, ids: randomIdGenerator })
  .balancesOf([ledgerAccountIds.treasury('base-usdc'), ledgerAccountIds.routingFees, ledgerAccountIds.routingLosses]));

describe('payment routing (RT-1 to RT-12, SG-2, SG-3, SG-7, step 12)', () => {
  it('returns the target\'s answer in one request with a payment key: the buyer pays the quote, the target its price, the fee is booked', async () => {
    const paying = await buyer();
    const before = await platformBalances();

    const response = await fetch(`${proxyUrl}/${at('api.target.dev')}/v1/pools?limit=10`, { headers: { authorization: `Bearer ${paying.key}`, 'x-api-key': 'buyer-own-key' } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pools: [1, 2, 3], path: '/v1/pools' });
    // RT-10: our receipt, the target's payment headers gone, its links through the routing link
    expect(response.headers.get('servicerouter-receipt')).toContain('amount="0.0011"');
    expect(response.headers.get('payment-response')).toBeNull();
    expect(response.headers.get('location')).toBe(`${config.urls.pay}/${at('api.target.dev')}/v1/pools/next`);
    // The plain option, not the cheaper Gateway one (AR16), at the target's price, to its address
    expect(paidRequests.at(-1)).toEqual({ path: '/v1/pools', amount: '1000', to: targetPayTo });
    expect(await balance(paying.id)).toBe(1_000_000n - 1_100n);
    // Credits capture once the response is out (PX-12)
    await expect.poll(async () => (await database.db.select().from(payments).where(eq(payments.buyerAccountId, paying.id)))[0]?.status).toBe('captured');
    const after = await platformBalances();
    expect(after[ledgerAccountIds.treasury('base-usdc')]! - (before[ledgerAccountIds.treasury('base-usdc')] ?? 0n)).toBe(1_000n);
    expect(after[ledgerAccountIds.routingFees]! - (before[ledgerAccountIds.routingFees] ?? 0n)).toBe(100n);
    const [row] = await database.db.select().from(payments).where(eq(payments.buyerAccountId, paying.id));
    expect(row).toMatchObject({ kind: 'routed', status: 'captured', amount: 1_100n, fee: 100n, targetHost: at('api.target.dev'), targetPath: '/v1/pools' });
    const [leg] = await database.db.select().from(targetPayments).where(eq(targetPayments.paymentId, row!.id));
    expect(leg).toMatchObject({ protocol: 'x402', network: base, asset: 'base-usdc', amount: 1_000n, payTo: targetPayTo, status: 'settled' });
    // SG-7: the Signer recorded what it signed
    const [signature] = await database.db.select().from(signatures).where(eq(signatures.id, leg!.signatureId));
    expect(signature).toMatchObject({ network: base, asset: 'base-usdc', atomicAmount: 1_000n, payTo: targetPayTo, quoteId: row!.id });
  });

  it('registers each paid endpoint once, through the internal API (RT-12, RT-13)', async () => {
    const paying = await buyer();
    await fetch(`${proxyUrl}/${at('api.target.dev')}/v1/pools`, { headers: { authorization: `Bearer ${paying.key}` } });
    await fetch(`${proxyUrl}/${at('api.target.dev')}/v1/pools`, { headers: { authorization: `Bearer ${paying.key}` } });

    await expect.poll(async () => (await database.db.select().from(routedEndpoints)).map(row => [row.host, row.path, row.feeBps])).toEqual([[at('api.target.dev'), '/v1/pools', null]]);
  });

  it('answers a call without a credential with the combined 402 at the quote, and a signed x402 payment then succeeds (RT-6)', async () => {
    const unpaid = await fetch(`${proxyUrl}/${at('api.target.dev')}/v1/pools`);
    const body = await unpaid.json() as { credits: { price: string } };
    const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);

    expect(unpaid.status).toBe(402);
    expect(body.credits.price).toBe('0.0011');
    expect(required.accepts.find(option => option.network === base)).toMatchObject({ amount: '1100' });

    const payer = privateKeyToAccount(generatePrivateKey());
    const client = new x402Client().register(base, new ExactEvmScheme(payer));
    const signature = encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === base) }));
    const paid = await fetch(`${proxyUrl}/${at('api.target.dev')}/v1/pools`, { headers: { 'payment-signature': signature } });

    expect(paid.status).toBe(200);
    expect(paid.headers.get('payment-response')).not.toBeNull();
    const [row] = await database.db.select().from(payments).where(eq(payments.rail, 'x402'));
    expect(row).toMatchObject({ kind: 'routed', status: 'settled', amount: 1_100n, fee: 100n });
  });

  it('charges nothing when the target fails, and books a routing loss when the target kept our payment anyway (RT-9)', async () => {
    const paying = await buyer();
    const before = await platformBalances();

    const response = await fetch(`${proxyUrl}/${at('api.target.dev')}/v1/broken`, { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(503);
    expect(await balance(paying.id)).toBe(1_000_000n);
    const after = await platformBalances();
    expect(after[ledgerAccountIds.routingLosses]! - (before[ledgerAccountIds.routingLosses] ?? 0n)).toBe(-1_000n);
  });

  it('books a routing loss once when an x402 buyer\'s settlement fails after the target was paid, and sends the buyer no answer (RT-9, P-9)', async () => {
    const link = `${proxyUrl}/${at('api.target.dev')}/v1/drained`;
    const required = decodePaymentRequiredHeader((await fetch(link)).headers.get('payment-required')!);
    const payer = privateKeyToAccount(generatePrivateKey());
    const client = new x402Client().register(base, new ExactEvmScheme(payer));
    const signature = encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === base) }));
    const before = await platformBalances();
    // The buyer emptied its wallet while the target answered: verified before, refused at settlement
    facilitator.handle('/settle', () => ({ status: 200, body: { success: false, errorReason: 'insufficient_funds', transaction: '', network: base } }));
    let response: Response;
    try {
      response = await fetch(link, { headers: { 'payment-signature': signature } });
    }
    finally {
      facilitator.reset();
    }

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'settlement_failed' } });
    const [buyerLeg] = await database.db.select().from(payments).where(eq(payments.targetPath, '/v1/drained'));
    expect(buyerLeg).toMatchObject({ kind: 'routed', rail: 'x402', status: 'failed' });
    const [targetLeg] = await database.db.select().from(targetPayments).where(eq(targetPayments.paymentId, buyerLeg!.id));
    expect(targetLeg).toMatchObject({ status: 'settled', lossBooked: false, amount: 1_000n });

    // The workers' job books it once, and alerts
    const book = createRoutingLosses({
      routing: createRoutingRepository({ db: database.db, clock: { now: () => new Date() } }),
      ledger: createLedger({ db: database.db, clock: { now: () => new Date() }, ids: randomIdGenerator }),
      metrics: createRoutingLossMetrics(new Registry()),
      logger: createLogger({ level: 'silent' }),
    });
    expect(await book()).toEqual({ booked: 1, failed: 0 });
    expect(await book()).toEqual({ booked: 0, failed: 0 });
    const after = await platformBalances();
    expect(after[ledgerAccountIds.routingLosses]! - (before[ledgerAccountIds.routingLosses] ?? 0n)).toBe(-1_000n);
    expect((await database.db.select().from(targetPayments).where(eq(targetPayments.paymentId, buyerLeg!.id)))[0]?.lossBooked).toBe(true);
  });

  it('refuses a target that asks more on the paid retry with 502 quote_exceeded, and charges nothing (RT-8)', async () => {
    const paying = await buyer();

    const response = await fetch(`${proxyUrl}/${at('api.target.dev')}/v1/pricier`, { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'quote_exceeded' } });
    expect(await balance(paying.id)).toBe(1_000_000n);
    // What was signed is the quoted price, never the higher one
    expect(paidRequests.filter(item => item.path === '/v1/pricier').map(item => item.amount)).toEqual(['1000']);
  });

  it('refuses our hosts, opted-out hosts, blocklisted hosts, and IP addresses; and answers a target without a 402 with not_payable (RT-1 to RT-3, RT-18)', async () => {
    await fetch(`${internalUrl}/internal/v1/blocklist/blocked.target.dev`, {
      method: 'PUT', headers: { 'x-internal-secret': internalSecret, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'abuse' }),
    });
    const codeOf = async (path: string) => {
      const response = await fetch(`${proxyUrl}${path}`);

      return [response.status, (await response.json() as { error: { code: string } }).error.code];
    };

    expect(await codeOf(`/${new URL(config.urls.pay).host}/v1/x`)).toEqual([400, 'host_not_allowed']);
    expect(await codeOf('/api.servicerouter.ai/v1/x')).toEqual([400, 'host_not_allowed']);
    expect(await codeOf(`/${at('optout.target.dev')}/v1/pools`)).toEqual([400, 'host_not_allowed']);
    expect(await codeOf(`/${at('blocked.target.dev')}/v1/pools`)).toEqual([400, 'host_not_allowed']);
    expect(await codeOf('/10.0.0.1/v1/pools')).toEqual([400, 'invalid_target']);
    expect(await codeOf(`/${at('api.target.dev')}/v1/free`)).toEqual([400, 'not_payable']);
  });

  it('quotes a link without paying at GET /_/check (RT-19)', async () => {
    const paidBefore = paidRequests.length;

    const answer = await (await fetch(`${proxyUrl}/_/check?url=${encodeURIComponent(`https://${at('api.target.dev')}/v1/pools?limit=5`)}`)).json();
    const refused = await (await fetch(`${proxyUrl}/_/check?url=${at('optout.target.dev')}/v1/pools`)).json();

    expect(answer).toEqual({
      payable: true,
      target: `https://${at('api.target.dev')}/v1/pools?limit=5`,
      price: { amount: '0.001', currency: 'USD', asset: 'base-usdc', network: base },
      quote: { amount: '0.0011', fee: '0.0001', currency: 'USD' },
      link: `${config.urls.pay}/${at('api.target.dev')}/v1/pools?limit=5`,
    });
    expect(refused).toMatchObject({ payable: false, reason: 'host_not_allowed' });
    expect(paidRequests.length).toBe(paidBefore);
  });

  it('pays no target while the Signer is away, the kill switch: 503, and the buyer isn\'t charged (SG-6)', async () => {
    const paying = await buyer();
    const keys = await createTestSecretKeys();
    const switchedOff = createApp({
      config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, opener: keys.opener, http,
      buyerHeaderKey: Secret.from('buyer-header-key-for-the-routing-tests'),
      signer: createSignerClient({ url: 'http://127.0.0.1:9', secret: Secret.from(signerSecret), timeoutMs: 1_000 }),
    });
    const port = (await switchedOff.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/${at('api.target.dev')}/v1/pools`, { headers: { authorization: `Bearer ${paying.key}` } });

      expect(response.status).toBe(503);
      await expect.poll(async () => (await database.db.select().from(payments).where(eq(payments.buyerAccountId, paying.id)))[0]?.status).toBe('released');
      expect(await balance(paying.id)).toBe(1_000_000n);
    }
    finally {
      await switchedOff.close();
    }
  });
});

// --- Diagnostic logs (T24) ---

const appLines = (app: string, requestId: string) => lines.filter(line => line['name'] === app && line['requestId'] === requestId);
const routedCall = async (path: string, requestId: string, key: string) =>
  fetch(`${proxyUrl}/${at('api.target.dev')}${path}`, { headers: { authorization: `Bearer ${key}`, 'x-request-id': requestId } });

describe('one request ID across apps (L-2, acceptance check 3)', () => {
  it('finds a routed call in the proxy\'s, the Signer\'s, and the internal API\'s lines, and logs the target\'s own request ID', async () => {
    const paying = await buyer();

    const response = await routedCall('/v1/traced', 'routed-trace-1', paying.key);

    expect(response.status).toBe(200);
    await expect.poll(() => appLines('api', 'routed-trace-1').some(line => line['msg'] === 'A routed endpoint was registered')).toBe(true);
    expect(appLines('proxy', 'routed-trace-1').map(line => line['msg'])).toEqual(expect.arrayContaining(['Routing quote', 'Routed call answered', 'Request completed']));
    expect(appLines('signer', 'routed-trace-1').map(line => line['msg'])).toEqual(expect.arrayContaining(['Signed a routed payment', 'Request completed']));
    expect(appLines('api', 'routed-trace-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ msg: 'A routed endpoint was registered', caller: 'proxy', host: at('api.target.dev'), path: '/v1/traced', result: 'created' }),
      expect.objectContaining({ msg: 'Request completed', route: '/internal/v1/routed-endpoints', status: 201 }),
    ]));
    expect(appLines('proxy', 'routed-trace-1').find(line => line['msg'] === 'Routed call answered')).toMatchObject({ targetRequestId: 'target-request-7' });
    // The target gets the same ID on the probe and the paid retry
    expect(target.requests.filter(request => request.path === '/v1/traced').map(request => request.headers['x-request-id'])).toEqual(['routed-trace-1', 'routed-trace-1']);
  });
});

describe('payment routing\'s lines (L-5)', () => {
  it('logs the probe\'s quote, the Signer\'s signature, the target\'s status, and whether it returned a receipt', async () => {
    const paying = await buyer();

    await routedCall('/v1/routing-lines', 'routing-lines-1', paying.key);
    await routedCall('/v1/routing-lines', 'routing-lines-2', paying.key);

    const proxyLines = appLines('proxy', 'routing-lines-1');
    expect(proxyLines.find(line => line['msg'] === 'Routing quote')).toMatchObject({
      level: 30, host: at('api.target.dev'), path: '/v1/routing-lines', targetStatus: 402, network: base, asset: 'base-usdc', x402Version: 2,
      price: '0.001', fee: '0.0001', quote: '0.0011', cached: false,
    });
    expect(proxyLines.find(line => line['msg'] === 'Routed call answered')).toMatchObject({
      level: 30, paymentId: expect.stringMatching(/^pay_/), signatureId: expect.stringMatching(/^sig_/), payTo: targetPayTo, targetStatus: 200, receipt: true, attempt: 2,
      durationMs: expect.any(Number),
    });
    await expect.poll(() => appLines('proxy', 'routing-lines-1').find(line => line['msg'] === 'Paid call finished'))
      .toMatchObject({ rail: 'credits', host: at('api.target.dev'), path: '/v1/routing-lines', amount: '0.0011', paymentStatus: 'captured' });
    // A repeat within the quote's TTL takes it from the cache, at debug
    expect(appLines('proxy', 'routing-lines-2').find(line => line['msg'] === 'Routing quote')).toMatchObject({ level: 20, cached: true });
    // L-6: the Signer's line, under the same request ID
    expect(appLines('signer', 'routing-lines-1').find(line => line['msg'] === 'Signed a routed payment')).toMatchObject({
      level: 30, quoteId: proxyLines.find(line => line['msg'] === 'Routed call answered')!['paymentId'], network: base, asset: 'base-usdc', amount: '0.001',
      atomicAmount: '1000', payTo: targetPayTo, signatureId: expect.stringMatching(/^sig_/), result: 'signed',
    });
  });

  it('logs why the probe refused: not payable with the target\'s status, no option we pay, and the host\'s reason', async () => {
    const refusal = async (path: string, requestId: string) => {
      await fetch(`${proxyUrl}${path}`, { headers: { 'x-request-id': requestId } });

      return appLines('proxy', requestId);
    };

    expect((await refusal(`/${at('api.target.dev')}/v1/free`, 'probe-free')).find(line => line['msg'] === 'The routed target didn\'t ask for a payment'))
      .toMatchObject({ level: 30, code: 'not_payable', host: at('api.target.dev'), targetStatus: 200 });
    expect((await refusal(`/${at('api.target.dev')}/v1/gateway-only`, 'probe-gateway')).find(line => line['msg'] === 'The routed target offers no payment we make'))
      .toMatchObject({ level: 30, code: 'unsupported_payment', targetStatus: 402, offered: [`exact ${base}`] });
    expect((await refusal(`/${at('optout.target.dev')}/v1/pools`, 'probe-optout')).find(line => line['msg'] === 'Routing refused the host'))
      .toMatchObject({ level: 30, code: 'host_not_allowed', reason: 'opted_out', host: at('optout.target.dev') });
    expect((await refusal('/api.servicerouter.ai/v1/x', 'probe-own')).find(line => line['msg'] === 'Routing refused the host'))
      .toMatchObject({ code: 'host_not_allowed', reason: 'own_host' });
  });

  it('logs the Signer\'s refusal reason from 422 signing_refused, in both apps: the stage and the reason (L-5, L-6, acceptance check 2)', async () => {
    const paying = await buyer();

    const response = await routedCall('/v1/expensive', 'signer-refusal-1', paying.key);

    expect(response.status).toBe(503);
    expect(appLines('proxy', 'signer-refusal-1').find(line => line['msg'] === 'The Signer didn\'t sign a routed payment')).toMatchObject({
      level: 40, paymentId: expect.stringMatching(/^pay_/), host: at('api.target.dev'), price: '0.6', quote: '0.66',
      code: 'signing_refused', reason: 'The amount is above the per-call maximum',
      signer: { method: 'POST', path: '/internal/v1/sign', status: 422, code: 'signing_refused', durationMs: expect.any(Number) },
    });
    expect(appLines('signer', 'signer-refusal-1').find(line => line['msg'] === 'Refused to sign a routed payment')).toMatchObject({
      level: 30, result: 'refused', reason: 'above_max_per_call', network: base, atomicAmount: '600000', payTo: targetPayTo, quotedPrice: '0.6',
    });
    await expect.poll(() => appLines('proxy', 'signer-refusal-1').find(line => line['msg'] === 'Paid call finished')).toMatchObject({ paymentStatus: 'released' });
  });
});

describe('the routing apps\' lines carry no secret (XC-7, rule 10)', () => {
  it('never logs a key, a shared secret, the hot wallet\'s key, a signed payment, or a buyer\'s own header for the target', async () => {
    expect(signedHeaders.length).toBeGreaterThan(0);
    expect(lines.some(line => line['name'] === 'signer')).toBe(true);

    const logged = JSON.stringify(lines);
    for (const secret of [signerSecret, internalSecret, signerKey, signerKey.slice(2), 'buyer-own-key', 'buyer-header-key-for-the-routing-tests', ...signedHeaders])
      expect(logged).not.toContain(secret);
    expect(logged).not.toMatch(/sr_test_[A-Za-z0-9_-]{20,}|srm_test_[A-Za-z0-9_-]{20,}/);
  });
});
