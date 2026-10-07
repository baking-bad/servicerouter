import { Registry } from '@prometheus-io/client';
import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { eq } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp as createApi, type ApiServer } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp, randomIdGenerator, Secret, type Server } from '@servicerouter/common';
import { assumeHostsVerified, findAsset, loadPlatformConfig, type PlatformConfig } from '@servicerouter/core';
import {
  createLedger, createRedisReplayStore, createRoutingRepository, ledgerAccountIds, payments, routedEndpoints, signatures, targetPayments, type RedisReplayStore,
} from '@servicerouter/db';
import { createFacilitators, initializeMpp, initializeX402 } from '@servicerouter/payments';
import { createApp as createSigner } from '@servicerouter/signer';
import { createRoutingLossMetrics, createRoutingLosses } from '@servicerouter/workers';
import {
  associatedTokenAddress, createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, createTestTempoPayer, decodeSolanaPayment, encodeBase58,
  startFakeFacilitator, startFakeSolanaRpc, startFakeTempoRpc, startFakeUpstream, type FakeFacilitator, type FakeSolanaRpc, type FakeTempoRpc, type FakeUpstream,
  type SolanaPayment, type TestDatabase, type TestRedis,
} from '@servicerouter/testing';

import { createApp, type ProxyServer } from '../../src/app.js';
import { createSignerClient } from '../../src/routing/support.js';

// T29 (P-6): payment routing pays x402 targets on Solana from the Signer's Solana wallet. Buyers pay as
// they do for any routed call: credits, x402, or MPP. The target's facilitator pays the transaction's fee.

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const signerSecret = 'signer-secret-0123456789abcdef-0123456789';
const mppSecretKey = 'mpp-secret-key-for-the-solana-routing-tests';
const targetHost = 'sol.target.dev';
// The target's Solana address, its facilitator's fee payer, and its Base address
const targetPayTo = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const targetFeePayer = encodeBase58(Uint8Array.from({ length: 32 }, () => 5));
const targetBasePayTo = '0x1111111111111111111111111111111111111111';
// The key in SOLANA_RPC_URL's path: no log line may hold it
const rpcKey = 'routing-solana-rpc-key-secret';
const generous = { requests: 100_000, windowSeconds: 60 };

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let target: FakeUpstream;
let tempoRpc: FakeTempoRpc;
let solanaRpc: FakeSolanaRpc;
let cdp: FakeFacilitator;
let store: RedisReplayStore;
let http: OutboundHttp;
let api: ApiServer;
let signer: Server;
let baseOnlySigner: Server;
let proxy: ProxyServer;
let noSolanaProxy: ProxyServer;
let apiUrl: string;
let internalUrl: string;
let proxyUrl: string;
let noSolanaUrl: string;
let mint: string;
let usdc: string;
let solanaWallet: KeyPairSigner;
const signerKey = generatePrivateKey();
const signerWallet = privateKeyToAccount(signerKey);
// What the target was paid, by path, with the Solana transaction as it decoded it
const paid: { path: string; network: string; amount: string; payment?: SolanaPayment }[] = [];
// Every PAYMENT-SIGNATURE the target received: none may reach a log
const received: string[] = [];
const lines: Record<string, unknown>[] = [];
const loggerFor = (name: string) => createLogger({ name, level: 'debug' }, {
  write: (line: string) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
    if (process.env['ROUTING_LOGS'])
      process.stdout.write(line);
  },
});

const solanaOption = (amount: string, extra: Record<string, unknown> = { feePayer: targetFeePayer }): PaymentRequirements => ({
  scheme: 'exact', network: solana, amount, asset: mint, payTo: targetPayTo, maxTimeoutSeconds: 60, extra,
} as PaymentRequirements);

const baseOption = (amount: string): PaymentRequirements => ({
  scheme: 'exact', network: base, amount, asset: usdc, payTo: targetBasePayTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' },
} as PaymentRequirements);

/** The target's options by path: USDC on Solana at $0.001, unless the path asks for something else. */
const optionsFor = (path: string): PaymentRequirements[] => {
  switch (path) {
    case '/v1/no-fee-payer': return [solanaOption('1000', {})];
    case '/v1/expensive': return [solanaOption('60000')];
    case '/v1/tie': return [solanaOption('2000'), baseOption('2000')];
    case '/v1/solana-cheaper': return [baseOption('2000'), solanaOption('1999')];
    default: return [solanaOption('1000')];
  }
};

beforeAll(async () => {
  [database, redis, target, tempoRpc, solanaRpc, cdp, solanaWallet] = await Promise.all([
    createTestDatabase(), createTestRedis(), startFakeUpstream({ hosts: [targetHost] }), startFakeTempoRpc(), startFakeSolanaRpc(),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }), generateKeyPairSigner(),
  ]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        routingFeeBps: 0,
        rateLimits: { signup: generous, paymentKey: generous, service: generous, unpaidIp: generous },
        facilitators: [
          { name: 'cdp', url: cdp.url, networks: [base, solana] },
          { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:preprod'], enabled: false },
        ],
        signer: { maxPerCall: '0.05', maxPerNetworkPerDay: '100', wallets: { solana: solanaWallet.address } },
      })).toString('base64'),
    },
  });
  mint = findAsset(config, 'solana-usdc')!.address;
  usdc = findAsset(config, 'base-usdc')!.address;

  target.handle(async (request, response) => {
    const path = request.path.split('?')[0]!;
    const url = `https://${targetHost}${path}`;
    const header = request.headers['payment-signature'];
    if (typeof header !== 'string') {
      const required = encodePaymentRequiredHeader({ x402Version: 2, error: 'Payment required', resource: { url, mimeType: 'application/json' }, accepts: optionsFor(path) } as never);
      response.writeHead(402, { 'payment-required': required, 'content-type': 'application/json' }).end('{}');
      return;
    }
    received.push(header);
    // RT-8: asks more on the paid retry, and settles nothing
    if (path === '/v1/pricier') {
      const required = encodePaymentRequiredHeader({ x402Version: 2, error: 'Payment required', resource: { url }, accepts: [solanaOption('5000')] } as never);
      response.writeHead(402, { 'payment-required': required }).end('{}');
      return;
    }
    const signed = decodePaymentSignatureHeader(header) as unknown as { accepted: PaymentRequirements; payload: Record<string, any> };
    const network = signed.accepted.network;
    if (network === solana) {
      // As its facilitator would: the transaction pays exactly the amount asked, into its payTo's USDC account, with its fee payer
      const payment = decodeSolanaPayment(signed.payload['transaction'] as string);
      paid.push({ path, network, amount: signed.accepted.amount, payment });
    }
    else
      paid.push({ path, network, amount: String(signed.payload['authorization']?.value) });
    const settled = encodePaymentResponseHeader({ success: true, transaction: encodeBase58(Uint8Array.from({ length: 64 }, () => 7)), network, payer: solanaWallet.address } as never);
    // RT-9: a failure that keeps our payment
    if (path === '/v1/broken') {
      response.writeHead(500, { 'payment-response': settled }).end('{"error":"boom"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'payment-response': settled }).end(JSON.stringify({ path, paidOn: network }));
  });

  http = new OutboundHttp({
    ownHosts: config.ownHosts, resolver: createFakeResolver({ [targetHost]: '127.0.0.1' }), addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: target.ca, connectTimeoutMs: 5_000, totalTimeoutMs: 5_000,
  });
  const keys = await createTestSecretKeys();
  store = createRedisReplayStore({ redis });
  const signerDependencies = { config, logger: loggerFor('signer'), postgres: database.postgres, redis, secret: Secret.from(signerSecret) };
  // Base and Solana, with the Solana RPC's key in its path; and a Signer without SIGNER_SOLANA_KEY
  signer = createSigner({ ...signerDependencies, wallets: { base: signerWallet, solana: solanaWallet }, solanaRpcUrl: Secret.from(`${solanaRpc.url}/${rpcKey}`) });
  baseOnlySigner = createSigner({ ...signerDependencies, wallets: { base: signerWallet } });
  api = createApi({ config, logger: loggerFor('api'), postgres: database.postgres, redis, sealer: keys.sealer, ownership: assumeHostsVerified, internalSecret: Secret.from(internalSecret) });
  const listen = { host: '127.0.0.1', port: 0, metricsPort: 0 };
  const [signerPorts, baseOnlyPorts, apiPorts] = await Promise.all([signer.listen(listen), baseOnlySigner.listen(listen), api.listen({ ...listen, internalPort: 0 })]);
  apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  internalUrl = `http://127.0.0.1:${apiPorts.internalPort!}`;
  const x402 = await initializeX402({ config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth'); }, clock: { now: () => new Date() } }), timeoutMs: 5_000 });
  const mppSetup = await initializeMpp({ config, secretKey: Secret.from(mppSecretKey), store, timeoutMs: 5_000, rpcUrl: tempoRpc.url });
  const proxyFor = (signerPort: number) => createApp({
    config, logger: loggerFor('proxy'), postgres: database.postgres, redis, opener: keys.opener, http, buyerHeaderKey: Secret.from('buyer-header-key-for-the-solana-routing-tests'),
    x402, mpp: mppSetup, signer: createSignerClient({ url: `http://127.0.0.1:${signerPort}`, secret: Secret.from(signerSecret), timeoutMs: 5_000 }),
    internalApi: { url: internalUrl, secret: Secret.from(internalSecret) },
    ownershipFileUrl: host => target.url(host, '/.well-known/servicerouter.json'),
  });
  proxy = proxyFor(signerPorts.port);
  noSolanaProxy = proxyFor(baseOnlyPorts.port);
  const [proxyPorts, noSolanaPorts] = await Promise.all([proxy.listen(listen), noSolanaProxy.listen(listen)]);
  proxyUrl = `http://127.0.0.1:${proxyPorts.port}`;
  noSolanaUrl = `http://127.0.0.1:${noSolanaPorts.port}`;
});

afterAll(async () => {
  await Promise.all([api?.close(), proxy?.close(), noSolanaProxy?.close(), signer?.close(), baseOnlySigner?.close()]);
  await Promise.all([http?.close(), target?.close(), tempoRpc?.close(), solanaRpc?.close(), cdp?.close(), store?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// The fake target listens on a port of its own: links name it, as /<host>:<port>/… allows (RT-1)
const link = (path: string, at = proxyUrl): string => `${at}/${targetHost}:${target.port}${path}`;
const clock = { now: () => new Date() };
const ledger = () => createLedger({ db: database.db, clock, ids: randomIdGenerator });

/** A buyer with $1 of credits and a payment key. */
const buyer = async () => {
  const account = await (await fetch(`${apiUrl}/v1/accounts`, { method: 'POST' })).json() as { id: string; masterKey: string };
  const { key } = await (await fetch(`${apiUrl}/v1/keys`, {
    method: 'POST', headers: { authorization: `Bearer ${account.masterKey}`, 'content-type': 'application/json' }, body: '{}',
  })).json() as { key: string };
  await fetch(`${internalUrl}/internal/v1/accounts/${account.id}/credits`, {
    method: 'POST', headers: { 'x-internal-secret': internalSecret, 'content-type': 'application/json' }, body: JSON.stringify({ amount: '1', reference: `credit-${account.id}` }),
  });

  return { ...account, key };
};

const balance = async (accountId: string): Promise<bigint> => (await ledger().balance(accountId)).available;
const legOf = async (targetPath: string) => {
  const [buyerLeg] = await database.db.select().from(payments).where(eq(payments.targetPath, targetPath));
  const [targetLeg] = buyerLeg ? await database.db.select().from(targetPayments).where(eq(targetPayments.paymentId, buyerLeg.id)) : [];

  return { buyerLeg, targetLeg };
};
const treasuryAndLosses = async () => {
  const found = await ledger().balancesOf([ledgerAccountIds.treasury('solana-usdc'), ledgerAccountIds.routingLosses]);

  return { treasury: found.get(ledgerAccountIds.treasury('solana-usdc')) ?? 0n, losses: found.get(ledgerAccountIds.routingLosses) ?? 0n };
};

describe('payment routing pays x402 targets on Solana (RT-4 to RT-12, SG-1 to SG-8, T29)', () => {
  it('pays a Solana target for a payment key: a USDC transfer of exactly its price to its payTo, with its fee payer, recorded with the receipt (RT-5, RT-7, RT-10, RT-11, SG-2, SG-7, SG-8)', async () => {
    const paying = await buyer();
    const before = await treasuryAndLosses();

    const response = await fetch(link('/v1/slot'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: '/v1/slot', paidOn: solana });
    // RT-10: our receipt, never the target's
    expect(response.headers.get('servicerouter-receipt')).toContain('amount="0.001"');
    expect(response.headers.get('payment-response')).toBeNull();
    expect(await balance(paying.id)).toBe(1_000_000n - 1_000n);
    const { payment } = paid.at(-1)!;
    expect(payment).toEqual({
      feePayer: targetFeePayer,
      signedBy: [solanaWallet.address],
      unsignedBy: [targetFeePayer],
      transfer: {
        source: await associatedTokenAddress(solanaWallet.address, mint), mint, destination: await associatedTokenAddress(targetPayTo, mint), authority: solanaWallet.address,
        amount: 1_000n, decimals: 6,
      },
    });
    // RT-11: both legs
    const { buyerLeg, targetLeg } = await legOf('/v1/slot');
    expect(buyerLeg).toMatchObject({ kind: 'routed', rail: 'credits', amount: 1_000n });
    expect(targetLeg).toMatchObject({
      protocol: 'x402', network: solana, asset: 'solana-usdc', amount: 1_000n, atomicAmount: 1_000n, payTo: targetPayTo, status: 'settled', receipt: expect.any(String),
      transactionHash: expect.any(String),
    });
    const [signature] = await database.db.select().from(signatures).where(eq(signatures.id, targetLeg!.signatureId));
    expect(signature).toMatchObject({ protocol: 'x402', network: solana, asset: 'solana-usdc', atomicAmount: 1_000n, payTo: targetPayTo, quoteId: buyerLeg!.id });
    await expect.poll(async () => (await legOf('/v1/slot')).buyerLeg?.status).toBe('captured');
    // The target's price leaves the Solana treasury
    expect((await treasuryAndLosses()).treasury - before.treasury).toBe(1_000n);
    // RT-12: the endpoint that answered 402 is registered
    await expect.poll(async () => (await database.db.select().from(routedEndpoints)).map(row => row.path)).toContain('/v1/slot');
  });

  it('refuses a Solana target that asks more on the paid retry: 502 quote_exceeded, and nobody charged (RT-8)', async () => {
    const paying = await buyer();

    const response = await fetch(link('/v1/pricier'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'quote_exceeded' } });
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect((await legOf('/v1/pricier')).targetLeg).toMatchObject({ network: solana, status: 'failed' });
  });

  it('is paid by an x402 buyer on Base, and by an MPP buyer on Tempo (RT-6)', async () => {
    const unpaid = await fetch(link('/v1/x402-buyer'));
    const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);
    const client = new x402Client().register(base, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
    const signed = encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === base) }));

    const viaX402 = await fetch(link('/v1/x402-buyer'), { headers: { 'payment-signature': signed } });

    expect(viaX402.status).toBe(200);
    expect(await legOf('/v1/x402-buyer')).toMatchObject({ buyerLeg: { rail: 'x402', network: base, status: 'settled', amount: 1_000n }, targetLeg: { network: solana, status: 'settled' } });

    const payer = createTestTempoPayer({ rpcUrl: tempoRpc.url });
    const credential = await payer.credentialFor(await fetch(link('/v1/mpp-buyer')));
    const viaMpp = await fetch(link('/v1/mpp-buyer'), { headers: { authorization: credential } });

    expect(viaMpp.status).toBe(200);
    expect(await legOf('/v1/mpp-buyer')).toMatchObject({ buyerLeg: { rail: 'mpp', status: 'settled', amount: 1_000n }, targetLeg: { network: solana, status: 'settled' } });
  });

  it('chooses Base over Solana at the same price, and a cheaper Solana option (RT-4)', async () => {
    const paying = await buyer();

    const tie = await fetch(link('/v1/tie'), { headers: { authorization: `Bearer ${paying.key}` } });
    const cheaper = await fetch(link('/v1/solana-cheaper'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(await tie.json()).toEqual({ path: '/v1/tie', paidOn: base });
    expect(await cheaper.json()).toEqual({ path: '/v1/solana-cheaper', paidOn: solana });
    expect(paid.at(-1)).toMatchObject({ path: '/v1/solana-cheaper', network: solana, payment: { transfer: { amount: 1_999n } } });
  });

  it('refuses a Solana option without a fee payer: 502 unsupported_payment with its reason, and nobody charged (RT-4)', async () => {
    const paying = await buyer();

    const response = await fetch(link('/v1/no-fee-payer'), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'solana-no-fee-payer' } });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_payment' } });
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(lines.find(line => line['requestId'] === 'solana-no-fee-payer' && line['msg'] === 'The routed target offers no payment we make')).toMatchObject({
      code: 'unsupported_payment', reasons: ['no_fee_payer'],
    });
  });

  it('refuses above the per-call maximum and without SIGNER_SOLANA_KEY: 503, the Signer\'s reason in the log, and nobody charged (SG-1, SG-3)', async () => {
    const paying = await buyer();

    const expensive = await fetch(link('/v1/expensive'), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'solana-expensive' } });
    const noWallet = await fetch(link('/v1/no-wallet', noSolanaUrl), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'solana-no-wallet' } });

    expect([expensive.status, noWallet.status]).toEqual([503, 503]);
    expect(await balance(paying.id)).toBe(1_000_000n);
    const refusal = (requestId: string) => lines.find(line => line['requestId'] === requestId && line['msg'] === 'The Signer didn\'t sign a routed payment');
    expect(refusal('solana-expensive')).toMatchObject({ protocol: 'x402', network: solana, code: 'signing_refused', reason: 'The amount is above the per-call maximum' });
    expect(refusal('solana-no-wallet')).toMatchObject({ network: solana, code: 'signing_refused', reason: 'The Signer holds no wallet on Solana Devnet' });
    expect(lines.find(line => line['requestId'] === 'solana-no-wallet' && line['msg'] === 'Refused to sign a routed payment')).toMatchObject({ reason: 'no_wallet' });
  });

  it('books one routing loss when the target answers 5xx with a successful PAYMENT-RESPONSE, which the routing_losses job doesn\'t book again (RT-9)', async () => {
    const paying = await buyer();
    const before = await treasuryAndLosses();

    const response = await fetch(link('/v1/broken'), { headers: { authorization: `Bearer ${paying.key}` } });
    const book = createRoutingLosses({
      routing: createRoutingRepository({ db: database.db, clock }), ledger: ledger(), metrics: createRoutingLossMetrics(new Registry()), logger: createLogger({ level: 'silent' }),
    });

    expect(response.status).toBe(503);
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(await book()).toEqual({ booked: 0, failed: 0 });
    const after = await treasuryAndLosses();
    expect(after.losses - before.losses).toBe(-1_000n);
    expect(after.treasury - before.treasury).toBe(1_000n);
    expect((await legOf('/v1/broken')).targetLeg).toMatchObject({ network: solana, status: 'settled', lossBooked: true, receipt: expect.any(String) });
  });

  it('quotes a Solana-only target at GET /_/check without paying (RT-19)', async () => {
    const before = paid.length;

    const checked = await (await fetch(`${proxyUrl}/_/check?url=${encodeURIComponent(`https://${targetHost}:${target.port}/v1/checked`)}`)).json();

    expect(checked).toEqual({
      payable: true, target: `https://${targetHost}:${target.port}/v1/checked`,
      price: { amount: '0.001', currency: 'USD', asset: 'solana-usdc', network: solana },
      quote: { amount: '0.001', fee: '0', currency: 'USD' },
      link: `${config.urls.pay}/${targetHost}:${target.port}/v1/checked`,
    });
    expect(paid.length).toBe(before);
  });

  it('names the network and amount on the routing and Signer lines, and never logs the RPC\'s key, a signed transaction, or a key (L-5, L-6, rule 10)', async () => {
    const paying = await buyer();
    await fetch(link('/v1/logged'), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'solana-logged' } });
    const ofCall = (app: string, msg: string) => lines.find(line => line['requestId'] === 'solana-logged' && line['name'] === app && line['msg'] === msg);

    expect(ofCall('proxy', 'Routing quote')).toMatchObject({ protocol: 'x402', network: solana, asset: 'solana-usdc', price: '0.001' });
    expect(ofCall('signer', 'Signed a routed payment')).toMatchObject({ protocol: 'x402', network: solana, amount: '0.001' });
    expect(ofCall('proxy', 'Routed call answered')).toMatchObject({ network: solana, targetStatus: 200, receipt: true });

    const logged = JSON.stringify(lines);
    expect(received.length).toBeGreaterThan(4);
    for (const header of received) {
      expect(logged).not.toContain(header);
      const transaction = (decodePaymentSignatureHeader(header) as unknown as { payload: { transaction?: string } }).payload.transaction;
      if (transaction)
        expect(logged).not.toContain(transaction);
    }
    expect(logged).not.toContain(rpcKey);
    expect(logged).not.toContain(signerKey.slice(2));
  });
});
