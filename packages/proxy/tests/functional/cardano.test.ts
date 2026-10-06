import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { ExactCardanoScheme } from '@x402/cardano/exact/client';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp as createApi, type ApiServer } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp, Secret, type ServiceId } from '@servicerouter/common';
import { assumeHostsVerified, loadPlatformConfig, type Payment, type PlatformConfig } from '@servicerouter/core';
import { createLedger, createPaymentRepository } from '@servicerouter/db';
import { createAssetLookup, createFacilitatorLookup, createFacilitators, initializeX402, type X402Setup } from '@servicerouter/payments';
import {
  cardanoAnswers, createFakeResolver, createTestCardanoWallet, createTestDatabase, createTestRedis, createTestSecretKeys, facilitatorAnswers,
  startFakeBlockfrost, startFakeFacilitator, startFakeUpstream, type FacilitatorAnswer, type FakeBlockfrost, type FakeFacilitator,
  type FakeUpstream, type TestCardanoWallet, type TestDatabase, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';
import { createSettlementFollowUp } from '@servicerouter/workers';

import { createApp, type ProxyServer } from '../../src/app.js';
import { createBuyerHeaderValue } from '../../src/payments/buyer.js';

// Step 6: x402 on Cardano, USDM on preprod, through the Cardano facilitator (CF-6, PR-8)
const preprod = 'cardano:preprod';
const usdm = 'e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d';
const treasury = 'addr_test1vqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygxrcya6';
const buyerHeaderKey = 'buyer-header-key-for-the-cardano-tests';
const generous = { requests: 100_000, windowSeconds: 60 };
const settleTimeoutMs = 400;
const clock = { now: () => new Date() };

const openapi = {
  openapi: '3.1.0',
  info: { title: 'Reports', version: '1.0.0' },
  paths: {
    '/report/{city}': { get: { operationId: 'getReport', summary: 'A city report', responses: { 200: { description: 'OK' } } } },
    '/ping': { get: { operationId: 'getPing', responses: { 200: { description: 'OK' } } } },
  },
};

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let keys: TestSecretKeys;
let upstream: FakeUpstream;
let facilitator: FakeFacilitator;
let blockfrost: FakeBlockfrost;
let wallet: TestCardanoWallet;
let setup: X402Setup;
let apiHttp: OutboundHttp;
let proxyHttp: OutboundHttp;
let api: ApiServer;
let proxy: ProxyServer;
let apiUrl: string;
let proxyUrl: string;
let seller: { readonly id: string; readonly masterKey: string };
const serviceId = 'cardano-reports' as ServiceId;

const serviceYaml = () => `servicerouter:
  version: "1"

service:
  id: ${serviceId}
  title: Reports
  description: City reports.
  category: weather

payouts:
  default:
    asset: cardano-usdm
    address: addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5

payments:
  default:
    amount: "0.05"

upstreams:
  - baseUrl: ${upstream.url('api.example.com', '/v1')}
    openapi: ${upstream.url('api.example.com', '/openapi.json')}
    auth: main-key

routes:
  getPing:
    payment:
      amount: "0.001"

credentials:
  main-key:
    type: http
    scheme: bearer
    secret: report-key
`;

beforeAll(async () => {
  [database, redis, keys, upstream, facilitator, blockfrost] = await Promise.all([
    createTestDatabase(),
    createTestRedis(),
    createTestSecretKeys(),
    startFakeUpstream({ hosts: ['api.example.com'] }),
    startFakeFacilitator({ networks: [preprod] }),
    startFakeBlockfrost(),
  ]);
  // A wallet made for this run, holding ADA for fees and 10 tUSDM
  wallet = createTestCardanoWallet({ network: preprod, blockfrost });
  blockfrost.fund(wallet.address, { lovelace: 5_000_000n, assets: { [usdm]: 10_000_000n } });

  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        feeBps: 250,
        rateLimits: { signup: generous, paymentKey: generous, service: generous, unpaidIp: generous },
        timeouts: { settleMs: settleTimeoutMs },
        facilitators: [
          { name: 'cdp', url: 'https://api.cdp.coinbase.com/platform/v2/x402', networks: ['eip155:84532', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'], enabled: false },
          { name: 'cardano', url: facilitator.url, networks: [preprod] },
        ],
      })).toString('base64'),
    },
  });
  upstream.handle((request, response) => {
    if (request.path === '/openapi.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(openapi));
    }
    else {
      response.writeHead(200, { 'content-type': 'application/json', etag: '"report-1"' });
      response.end(JSON.stringify({ path: request.path, buyer: request.headers['servicerouter-buyer'] ?? null }));
    }
  });
  const resolver = createFakeResolver({ 'api.example.com': '127.0.0.1' });
  const outbound = { ownHosts: config.ownHosts, resolver, addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }), ca: upstream.ca };
  apiHttp = new OutboundHttp({ ...outbound, connectTimeoutMs: 5_000 });
  proxyHttp = new OutboundHttp({ ...outbound, connectTimeoutMs: 5_000, totalTimeoutMs: 5_000, maxRequestBytes: config.sizeLimits.requestBodyBytes });
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
  const submitted = await fetch(`${apiUrl}/v1/services/${serviceId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${seller.masterKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ config: serviceYaml(), secrets: { 'report-key': 'sk-report' } }),
  });
  if (submitted.status >= 300)
    throw new Error(`Submit failed: ${await submitted.text()}`);
});

afterAll(async () => {
  await Promise.all([api?.close(), proxy?.close()]);
  await Promise.all([apiHttp?.close(), proxyHttp?.close(), upstream?.close(), facilitator?.close(), blockfrost?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// The facilitator says who paid: the wallet that owns the payment's nonce UTxO
const verifiedByWallet = () => (): FacilitatorAnswer => ({ status: 200, body: { isValid: true, payer: wallet.address } });

beforeEach(() => {
  facilitator.reset();
  facilitator.handle('/verify', verifiedByWallet());
});

// --- Helpers ---

let counter = 0;
const nextRequestId = (label: string) => {
  counter += 1;

  return `cardano-${label}-${counter}`;
};

const challenge = async (path: string): Promise<{ readonly response: Response; readonly required: PaymentRequired | undefined }> => {
  const response = await fetch(`${proxyUrl}/service/${serviceId}${path}`);
  const header = response.headers.get('payment-required');

  return { response, required: header ? decodePaymentRequiredHeader(header) : undefined };
};

/** A PAYMENT-SIGNATURE for the 402's Cardano option, built and signed by `@x402/cardano`'s client with the test wallet. */
const pay = async (path: string): Promise<string> => {
  const { required } = await challenge(path);
  const client = new x402Client().register(preprod, new ExactCardanoScheme(wallet.signer));

  return encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required!, accepts: required!.accepts.filter(option => option.network === preprod) }));
};

const paidCall = async (path = '/report/oslo', label = 'paid') => {
  const signature = await pay(path);
  const requestId = nextRequestId(label);
  const before = { upstream: upstream.requests.length, facilitator: facilitator.requests.length };
  const response = await fetch(`${proxyUrl}/service/${serviceId}${path}`, { headers: { 'payment-signature': signature, 'x-request-id': requestId } });
  const body = await response.text();

  return {
    response,
    body,
    requestId,
    signature,
    upstreamCalls: () => upstream.requests.length - before.upstream,
    settles: () => facilitator.requests.slice(before.facilitator).filter(request => request.path === '/settle'),
  };
};

const paymentFor = async (requestId: string): Promise<Payment | undefined> => {
  const { rows } = await database.db.execute<{ id: string }>(sql`select id from payments where request_id = ${requestId}`);

  return rows[0] ? createPaymentRepository({ db: database.db, clock }).find(rows[0].id) : undefined;
};

const earnedOnX402 = async (): Promise<number> => {
  const earnings = await (await fetch(`${apiUrl}/v1/services/${serviceId}/earnings`, { headers: { authorization: `Bearer ${seller.masterKey}` } })).json() as { earned: { byRail: Record<string, string> } };

  return Number(earnings.earned.byRail['x402'] ?? 0);
};

const followUp = () => createSettlementFollowUp({
  payments: createPaymentRepository({ db: database.db, clock }),
  ledger: createLedger({ db: database.db, clock, ids: { next: () => crypto.randomUUID() } }),
  facilitatorFor: createFacilitatorLookup(config, setup.facilitators),
  assetName: createAssetLookup(config),
  feeBps: config.feeBps,
  logger: createLogger({ level: 'silent' }),
})();

const transaction = () => crypto.randomUUID().replaceAll('-', '').repeat(2);

/** The settles the facilitator got for the payment in a PAYMENT-SIGNATURE, by its signed transaction. */
const settlesOf = (signature: string) => {
  const signed = (decodePaymentSignatureHeader(signature).payload as { transaction: string }).transaction;

  return facilitator.requests.filter(request => request.path === '/settle'
    && (request.body as { paymentPayload?: { payload?: { transaction?: string } } } | undefined)?.paymentPayload?.payload?.transaction === signed);
};

// --- Tests ---

describe('the combined 402 with Cardano (PR-2, PR-3, PR-8, CF-5, step 6)', () => {
  it('offers USDM on preprod for a call at the asset\'s minimum price, with the default transfer and block inclusion', async () => {
    const { response, required } = await challenge('/report/oslo');

    expect(response.status).toBe(402);
    expect(required?.accepts).toEqual([{
      scheme: 'exact',
      network: preprod,
      asset: usdm,
      amount: '50000',
      payTo: treasury,
      maxTimeoutSeconds: expect.any(Number),
      // The SDK leaves out the default transfer method, which an absent one means, and adds what the
      // facilitator advertises about fees
      extra: { areFeesSponsored: false, confirmationPolicy: { l1Confirmations: 0 } },
    }]);
  });

  it('offers no Cardano option below the minimum price: the 402 carries credits only (PR-3)', async () => {
    const { response, required } = await challenge('/ping');

    expect(response.status).toBe(402);
    expect(required).toBeUndefined();
    expect(await response.json()).toMatchObject({ credits: { price: '0.001' } });
  });
});

describe('a USDM payment on Cardano (PR-5, PX-15, CF-6, step 6)', () => {
  it('signed by @x402/cardano\'s client gets 200 through the facilitator, settled, booked, with PAYMENT-RESPONSE', async () => {
    const earnedBefore = await earnedOnX402();

    const { response, body, requestId, signature, settles } = await paidCall();

    expect(response.status).toBe(200);
    const payment = await paymentFor(requestId);
    expect(payment).toMatchObject({
      status: 'settled', rail: 'x402', network: preprod, asset: usdm, atomicAmount: 50_000n, amount: 50_000n, fee: 1_250n, decision: 'billable',
      sellerAccountId: seller.id, transactionHash: expect.stringMatching(/^[0-9a-f]{64}$/), needsReview: false,
    });
    expect(decodePaymentResponseHeader(response.headers.get('payment-response')!)).toMatchObject({ success: true, network: preprod, transaction: payment!.transactionHash });
    expect(await earnedOnX402()).toBeCloseTo(earnedBefore + 0.04875, 6);
    expect(JSON.parse(body)).toMatchObject({ path: '/v1/report/oslo', buyer: createBuyerHeaderValue(Secret.from(buyerHeaderKey))(`address:${preprod}:${wallet.address}`, serviceId) });
    // The facilitator gets the signed transaction and the quote it answers, with our confirmation policy
    const [settle] = settles();
    const payload = decodePaymentSignatureHeader(signature);
    expect(settle?.body).toMatchObject({
      x402Version: 2,
      paymentPayload: { payload: { transaction: (payload.payload as { transaction: string }).transaction, nonce: expect.stringMatching(/^[0-9a-f]{64}#0$/) } },
      paymentRequirements: { network: preprod, asset: usdm, amount: '50000', payTo: treasury, extra: { confirmationPolicy: { l1Confirmations: 0 } } },
    });
  });

  it('refuses a payment the facilitator rejects with 200 and isValid false: 402 payment_invalid, and the upstream records no request', async () => {
    facilitator.handle('/verify', cardanoAnswers.invalid());

    const { response, body, requestId, upstreamCalls } = await paidCall('/report/oslo', 'invalid');

    expect(response.status).toBe(402);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'payment_invalid', message: 'The facilitator rejected the payment: invalid_exact_cardano_payload_amount_insufficient' } });
    expect(upstreamCalls()).toBe(0);
    expect(await paymentFor(requestId)).toBeUndefined();
  });

  it('answers 503 facilitator_unavailable, not payment_invalid, when the chain backend is down at verify, and calls no upstream', async () => {
    // The image answers 200 with isValid false and a retryable reason: our outage, not the buyer's payment
    facilitator.handle('/verify', cardanoAnswers.verifyBackendDown());

    const { response, body, upstreamCalls } = await paidCall('/report/oslo', 'verify-down');

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'facilitator_unavailable' } });
    expect(upstreamCalls()).toBe(0);
  });

  it('refuses a payment for another transfer method, such as a Masumi escrow: it matches no option for the price (PR-8)', async () => {
    const payload = decodePaymentSignatureHeader(await pay('/report/oslo'));
    const escrow = { ...payload, accepted: { ...payload.accepted, extra: { ...payload.accepted.extra, assetTransferMethod: 'masumi' } } };
    const before = facilitator.requests.length;

    const response = await fetch(`${proxyUrl}/service/${serviceId}/report/oslo`, { headers: { 'payment-signature': encodePaymentSignatureHeader(escrow) } });

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: { code: 'payment_invalid', message: expect.stringContaining('doesn\'t match an option') } });
    expect(facilitator.requests.slice(before).some(request => request.path === '/verify')).toBe(false);
  });
});

describe('Cardano settle outcomes (PR-12, CF-6, step 6)', () => {
  it('sends the response on settlement_pending with a transaction, records settling, and the follow-up books it once', async () => {
    const hash = transaction();
    facilitator.handle('/settle', cardanoAnswers.pending(hash));

    const { response, body, requestId } = await paidCall('/report/bergen', 'pending');

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ path: '/v1/report/bergen' });
    expect(decodePaymentResponseHeader(response.headers.get('payment-response')!)).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: hash });
    expect(await paymentFor(requestId)).toMatchObject({ status: 'settling', transactionHash: hash });

    // Still pending at the first repeat: it waits for the next run
    expect(await followUp()).toMatchObject({ pending: 1, settled: 0 });
    facilitator.handle('/settle', () => ({ status: 200, body: { success: true, transaction: hash, network: preprod, payer: wallet.address, extra: { status: 'confirmed', confirmations: 1, transactionId: hash } } }));
    const earnedBefore = await earnedOnX402();

    expect(await followUp()).toMatchObject({ settled: 1 });
    expect(await paymentFor(requestId)).toMatchObject({ status: 'settled', transactionHash: hash, needsReview: false, fee: 1_250n });
    expect(await earnedOnX402()).toBeCloseTo(earnedBefore + 0.04875, 6);
    expect(await followUp()).toEqual({ settled: 0, failed: 0, pending: 0, unknown: 0, skipped: 0 });
  });

  it('repeats the stored settle identically: the same signed transaction and quote', async () => {
    facilitator.handle('/settle', cardanoAnswers.pending(transaction()));
    const { settles } = await paidCall('/report/molde', 'identical');
    const [first] = settles();
    const before = facilitator.requests.length;

    await followUp();

    const repeats = facilitator.requests.slice(before).filter(request => request.path === '/settle');
    expect(repeats.at(-1)?.body).toEqual(first?.body);
    // Settle it, so later runs have nothing left over
    facilitator.handle('/settle', facilitatorAnswers.settled);
    await followUp();
  });

  it('answers 502 settlement_failed when nothing was submitted (transaction ""): failed, nothing booked, no upstream bytes', async () => {
    facilitator.handle('/settle', cardanoAnswers.notSubmitted());
    const earnedBefore = await earnedOnX402();

    const { response, body, requestId } = await paidCall('/report/narvik', 'not-submitted');

    expect(response.status).toBe(502);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'settlement_failed' } });
    expect(body).not.toContain('/v1/report');
    expect(response.headers.get('etag')).toBeNull();
    expect(await paymentFor(requestId)).toMatchObject({ status: 'failed', transactionHash: undefined });
    expect(await earnedOnX402()).toBe(earnedBefore);
  });

  it.each([
    ['expired', cardanoAnswers.expired(transaction())],
    ['definitively rejected', cardanoAnswers.rejected(transaction())],
    ['a duplicate settlement', cardanoAnswers.duplicate()],
  ])('ends %s for good: 502 settlement_failed, failed, nothing booked, and never repeated', async (_case, answer) => {
    facilitator.handle('/settle', answer);
    const earnedBefore = await earnedOnX402();

    const { response, requestId, signature } = await paidCall('/report/alta', 'final');

    expect(response.status).toBe(502);
    expect(await paymentFor(requestId)).toMatchObject({ status: 'failed' });
    expect(await earnedOnX402()).toBe(earnedBefore);
    const settled = settlesOf(signature).length;
    await followUp();
    expect(settlesOf(signature)).toHaveLength(settled);
  });

  it.each([
    ['a 503', cardanoAnswers.backendDown(503)],
    ['a 200 that says to ask again', cardanoAnswers.backendDown(200)],
  ])('treats the chain backend down at settle (%s) as an unknown outcome: settling without a hash; the follow-up later confirms it and flags it', async (_case, answer) => {
    facilitator.handle('/settle', answer);

    const { response, body, requestId } = await paidCall('/report/tromso', 'backend-down');

    expect(response.status).toBe(502);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'settlement_failed' } });
    expect(await paymentFor(requestId)).toMatchObject({ status: 'settling', transactionHash: undefined, receipt: undefined });

    // Still down: the run counts it unknown and fails, so the job goes stale (WK-4)
    await expect(followUp()).rejects.toThrow();
    facilitator.handle('/settle', facilitatorAnswers.settled);
    await followUp();

    expect(await paymentFor(requestId)).toMatchObject({ status: 'settled', needsReview: true });
  });

  it('marks a pending payment failed when its transaction expires before it lands, and never repeats it again', async () => {
    const hash = transaction();
    facilitator.handle('/settle', cardanoAnswers.pending(hash));
    const { requestId, signature } = await paidCall('/report/kiruna', 'expires');
    facilitator.handle('/settle', cardanoAnswers.expired(hash));
    const earnedBefore = await earnedOnX402();

    expect(await followUp()).toMatchObject({ failed: 1 });

    expect(await paymentFor(requestId)).toMatchObject({ status: 'failed' });
    expect(await earnedOnX402()).toBe(earnedBefore);
    const settled = settlesOf(signature).length;
    await followUp();
    expect(settlesOf(signature)).toHaveLength(settled);
  });
});

describe('readiness with the Cardano facilitator (PX-17, CF-9, step 6)', () => {
  it('answers /_/ready with facilitator:cardano, and 503 while its /supported fails', async () => {
    expect(await (await fetch(`${proxyUrl}/_/ready`)).json()).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok', 'facilitator:cardano': 'ok' } });

    facilitator.handle('/supported', cardanoAnswers.backendDown());
    const failing = await fetch(`${proxyUrl}/_/ready`);

    expect(failing.status).toBe(503);
    expect(await failing.json()).toMatchObject({ checks: { 'facilitator:cardano': 'failed' } });
  });
});
