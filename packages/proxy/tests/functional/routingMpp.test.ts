import { Registry } from '@prometheus-io/client';
import { ExactCardanoScheme } from '@x402/cardano/exact/client';
import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { eq } from 'drizzle-orm';
import { Challenge, Credential, Receipt, Store } from 'mppx';
import { Mppx, tempo } from 'mppx/server';
import { createClient, http as viemHttp } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
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
  createFakeResolver, createTestCardanoWallet, createTestDatabase, createTestRedis, createTestSecretKeys, createTestTempoPayer, encodeBase58,
  startFakeBlockfrost, startFakeFacilitator, startFakeTempoRpc, startFakeUpstream, type FakeBlockfrost, type FakeFacilitator, type FakeTempoRpc,
  type FakeUpstream, type TestCardanoWallet, type TestDatabase, type TestRedis,
} from '@servicerouter/testing';

import { createApp, type ProxyServer } from '../../src/app.js';
import { createSignerClient } from '../../src/routing/support.js';

// T27: payment routing pays MPP targets on Tempo, and buyers pay a routed call with any rail, Cardano's included
const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const preprod = 'cardano:preprod';
const tempoNetwork = 'eip155:42431';
const usdm = 'e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d';
const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const signerSecret = 'signer-secret-0123456789abcdef-0123456789';
const mppSecretKey = 'mpp-secret-key-for-the-routing-tests!!';
const targetSecretKey = 'the-target-s-own-mpp-secret-key-000000';
const targetHost = 'mpp.target.dev';
// The target's Tempo address, and its Base one
const targetRecipient = '0x5555555555555555555555555555555555555555';
const targetPayTo = '0x1111111111111111111111111111111111111111';
const generous = { requests: 100_000, windowSeconds: 60 };

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let target: FakeUpstream;
let rpc: FakeTempoRpc;
let cdp: FakeFacilitator;
let cardano: FakeFacilitator;
let blockfrost: FakeBlockfrost;
let cardanoWallet: TestCardanoWallet;
let store: RedisReplayStore;
let http: OutboundHttp;
let api: ApiServer;
let signer: Server;
let baseOnlySigner: Server;
let proxy: ProxyServer;
let noTempoProxy: ProxyServer;
let apiUrl: string;
let internalUrl: string;
let proxyUrl: string;
let noTempoUrl: string;
let pathUsd: string;
let usdc: string;
const signerKey = generatePrivateKey();
const signerWallet = privateKeyToAccount(signerKey);
// Every Authorization and PAYMENT-SIGNATURE the target received: none may reach a log
const received: string[] = [];
// What the target was paid, by path: MPP receipts it issued, and x402 payments
const paid: { path: string; protocol: 'mpp' | 'x402'; amount: string }[] = [];
const lines: Record<string, unknown>[] = [];
const loggerFor = (name: string) => createLogger({ name, level: 'debug' }, {
  write: (line: string) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
    if (process.env['ROUTING_LOGS'])
      process.stdout.write(line);
  },
});

/** The target's MPP server: `mppx`'s Tempo charge in pull mode, checked against the fake Tempo RPC. */
const targetMpp = () => {
  const server = Mppx.create({
    methods: [tempo.charge({
      currencies: [pathUsd as `0x${string}`], decimals: 6, recipient: targetRecipient, chainId: tempoModerato.id, store: Store.memory(),
      getClient: () => createClient({ chain: tempoModerato, transport: viemHttp(rpc.url, { retryCount: 0 }) }), supportedModes: ['pull'], sponsorBudget: false,
      waitForConfirmation: true,
    })],
    secretKey: targetSecretKey,
    realm: targetHost,
  });
  const challenges = server.challenge as unknown as { tempo: { charge: (options: Record<string, unknown>) => Promise<Challenge.Challenge> } };
  const request = (amount: string) => ({ amount, currency: pathUsd, decimals: 6, recipient: targetRecipient, chainId: tempoModerato.id, supportedModes: ['pull'] });

  return {
    challenge: async (amount: string, scope: string) => Challenge.serialize(await challenges.tempo.charge({ ...request(amount), description: 'Pools', scope })),
    // Validates the credential, broadcasts its transaction, and waits for its receipt
    settle: async (credential: string, amount: string, scope: string) => Receipt.serialize(await server.broadcastCredential(credential, { request: request(amount), scope })),
  };
};

/** A Tempo charge `mppx`'s server would never make: one of the kinds routing refuses. */
const handMade = (details: Record<string, unknown>, request: Record<string, unknown> = {}) => Challenge.serialize(Challenge.from({
  id: 'hand-made', realm: targetHost, method: 'tempo', intent: 'charge', expires: new Date(Date.now() + 5 * 60_000).toISOString(),
  request: { amount: '1000', currency: pathUsd, recipient: targetRecipient, methodDetails: { chainId: tempoModerato.id, supportedModes: ['pull'], ...details }, ...request },
} as never));

const x402Option = (amount: string): PaymentRequirements => ({
  scheme: 'exact', network: base, amount, asset: usdc, payTo: targetPayTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' },
} as PaymentRequirements);

beforeAll(async () => {
  [database, redis, target, rpc, cdp, cardano, blockfrost] = await Promise.all([
    createTestDatabase(), createTestRedis(), startFakeUpstream({ hosts: [targetHost] }), startFakeTempoRpc(),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }),
    startFakeFacilitator({ networks: [preprod] }), startFakeBlockfrost(),
  ]);
  cardanoWallet = createTestCardanoWallet({ network: preprod, blockfrost });
  blockfrost.fund(cardanoWallet.address, { lovelace: 5_000_000n, assets: { [usdm]: 10_000_000n } });
  // The Cardano facilitator says who paid: the wallet that owns the payment's nonce UTxO
  cardano.handle('/verify', () => ({ status: 200, body: { isValid: true, payer: cardanoWallet.address } }));
  const loaded = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        routingFeeBps: 0,
        rateLimits: { signup: generous, paymentKey: generous, service: generous, unpaidIp: generous },
        facilitators: [
          { name: 'cdp', url: cdp.url, networks: [base, solana] },
          { name: 'cardano', url: cardano.url, networks: [preprod] },
        ],
        signer: { maxPerCall: '0.05', maxPerNetworkPerDay: '100' },
      })).toString('base64'),
    },
  });
  // As production for the hackathon: USDM is offered from $0.001
  config = { ...loaded, assets: loaded.assets.map(asset => asset.name === 'cardano-usdm' ? { ...asset, minPrice: 1_000n as typeof asset.minPrice } : asset) };
  pathUsd = findAsset(config, 'tempo-pathusd')!.address;
  usdc = findAsset(config, 'base-usdc')!.address;
  const mpp = targetMpp();

  target.handle(async (request, response) => {
    const path = request.path.split('?')[0]!;
    const scope = `https://${targetHost}${path}`;
    const amount = path === '/v1/expensive' ? '0.06' : path === '/v1/tie' ? '0.002' : '0.001';
    const authorization = request.headers['authorization'];
    const signature = request.headers['payment-signature'];
    if (typeof authorization === 'string' || typeof signature === 'string')
      received.push(String(authorization ?? signature));

    // x402 on Base beside MPP: at the same price, or dearer than MPP
    if ((path === '/v1/tie' || path === '/v1/cheaper') && typeof signature === 'string') {
      const payload = decodePaymentSignatureHeader(signature) as unknown as { payload: { authorization: { value: string } } };
      paid.push({ path, protocol: 'x402', amount: payload.payload.authorization.value });
      const settled = encodePaymentResponseHeader({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: base, payer: signerWallet.address } as never);
      response.writeHead(200, { 'content-type': 'application/json', 'payment-response': settled }).end(JSON.stringify({ path, paidWith: 'x402' }));
      return;
    }
    if (typeof authorization !== 'string') {
      const refused: Readonly<Record<string, string>> = {
        '/v1/push-only': handMade({ supportedModes: ['push'] }),
        '/v1/splits': handMade({ splits: [{ amount: '100', recipient: targetPayTo }] }),
        '/v1/currency': handMade({}, { currency: '0x20c0000000000000000000000000000000000001' }),
        '/v1/chain': handMade({ chainId: 4_217 }),
      };
      const headers: Record<string, string> = { 'content-type': 'application/json', 'www-authenticate': refused[path] ?? await mpp.challenge(amount, scope) };
      if (path === '/v1/tie' || path === '/v1/cheaper')
        headers['payment-required'] = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: scope }, accepts: [x402Option('2000')] } as never);
      response.writeHead(402, headers).end('{}');
      return;
    }
    // RT-8: asks more on the paid retry, and broadcasts nothing
    if (path === '/v1/pricier') {
      response.writeHead(402, { 'www-authenticate': await mpp.challenge('0.002', scope) }).end('{}');
      return;
    }
    let receipt: string;
    try {
      receipt = await mpp.settle(authorization, amount, scope);
    }
    catch {
      response.writeHead(402, { 'www-authenticate': await mpp.challenge(amount, scope) }).end('{}');
      return;
    }
    paid.push({ path, protocol: 'mpp', amount });
    // RT-9: a failure that keeps our payment
    if (path === '/v1/broken') {
      response.writeHead(500, { 'payment-receipt': receipt }).end('{"error":"boom"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'payment-receipt': receipt }).end(JSON.stringify({ path, paidWith: 'mpp' }));
  });

  http = new OutboundHttp({
    ownHosts: config.ownHosts, resolver: createFakeResolver({ [targetHost]: '127.0.0.1' }), addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: target.ca, connectTimeoutMs: 5_000, totalTimeoutMs: 5_000,
  });
  const keys = await createTestSecretKeys();
  store = createRedisReplayStore({ redis });
  // One key for Base and Tempo; and a Signer without SIGNER_TEMPO_KEY
  signer = createSigner({
    config, logger: loggerFor('signer'), postgres: database.postgres, redis, secret: Secret.from(signerSecret), wallets: { base: signerWallet, tempo: signerWallet }, tempoRpcUrl: rpc.url,
  });
  baseOnlySigner = createSigner({ config, logger: loggerFor('signer'), postgres: database.postgres, redis, secret: Secret.from(signerSecret), wallets: { base: signerWallet } });
  api = createApi({ config, logger: loggerFor('api'), postgres: database.postgres, redis, sealer: keys.sealer, ownership: assumeHostsVerified, internalSecret: Secret.from(internalSecret) });
  const listen = { host: '127.0.0.1', port: 0, metricsPort: 0 };
  const [signerPorts, baseOnlyPorts, apiPorts] = await Promise.all([signer.listen(listen), baseOnlySigner.listen(listen), api.listen({ ...listen, internalPort: 0 })]);
  apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  internalUrl = `http://127.0.0.1:${apiPorts.internalPort!}`;
  const x402 = await initializeX402({ config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth'); }, clock: { now: () => new Date() } }), timeoutMs: 5_000 });
  const mppSetup = await initializeMpp({ config, secretKey: Secret.from(mppSecretKey), store, timeoutMs: 5_000, rpcUrl: rpc.url });
  const proxyFor = (signerPort: number) => createApp({
    config, logger: loggerFor('proxy'), postgres: database.postgres, redis, opener: keys.opener, http, buyerHeaderKey: Secret.from('buyer-header-key-for-the-mpp-routing-tests'),
    x402, mpp: mppSetup, signer: createSignerClient({ url: `http://127.0.0.1:${signerPort}`, secret: Secret.from(signerSecret), timeoutMs: 5_000 }),
    internalApi: { url: internalUrl, secret: Secret.from(internalSecret) },
    ownershipFileUrl: host => target.url(host, '/.well-known/servicerouter.json'),
  });
  proxy = proxyFor(signerPorts.port);
  noTempoProxy = proxyFor(baseOnlyPorts.port);
  const [proxyPorts, noTempoPorts] = await Promise.all([proxy.listen(listen), noTempoProxy.listen(listen)]);
  proxyUrl = `http://127.0.0.1:${proxyPorts.port}`;
  noTempoUrl = `http://127.0.0.1:${noTempoPorts.port}`;
});

afterAll(async () => {
  await Promise.all([api?.close(), proxy?.close(), noTempoProxy?.close(), signer?.close(), baseOnlySigner?.close()]);
  await Promise.all([http?.close(), target?.close(), rpc?.close(), cdp?.close(), cardano?.close(), blockfrost?.close(), store?.close()]);
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
const routingLossesBalance = async (): Promise<bigint> => (await ledger().balancesOf([ledgerAccountIds.routingLosses])).get(ledgerAccountIds.routingLosses) ?? 0n;
const challengeOf = async (path: string): Promise<{ readonly response: Response; readonly required: PaymentRequired }> => {
  const response = await fetch(link(path));

  return { response, required: decodePaymentRequiredHeader(response.headers.get('payment-required')!) };
};

describe('payment routing pays MPP targets on Tempo (RT-3 to RT-12, SG-1 to SG-8, T27)', () => {
  it('pays an MPP target in pull mode for a payment key: the Signer signs, the target verifies and broadcasts it, and target_payments keeps the receipt (RT-5, RT-7, RT-10 to RT-12, RT-16, SG-2, SG-7, SG-8)', async () => {
    const paying = await buyer();

    const response = await fetch(link('/v1/pools'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: '/v1/pools', paidWith: 'mpp' });
    // RT-10: our receipt, never the target's
    expect(response.headers.get('servicerouter-receipt')).toContain('amount="0.001"');
    expect(response.headers.get('payment-receipt')).toBeNull();
    expect(paid.at(-1)).toEqual({ path: '/v1/pools', protocol: 'mpp', amount: '0.001' });
    expect(await balance(paying.id)).toBe(1_000_000n - 1_000n);
    // RT-16: the target got our credential, never the buyer's key
    expect(received.at(-1)).toMatch(/^Payment /);
    expect(received.some(value => value.includes(paying.key))).toBe(false);
    // RT-11: the target leg, with the target's receipt and its transaction
    const { buyerLeg, targetLeg } = await legOf('/v1/pools');
    expect(buyerLeg).toMatchObject({ kind: 'routed', rail: 'credits', amount: 1_000n });
    expect(targetLeg).toMatchObject({
      protocol: 'mpp', network: tempoNetwork, asset: 'tempo-pathusd', amount: 1_000n, atomicAmount: 1_000n, payTo: targetRecipient, status: 'settled',
      receipt: expect.any(String), transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    expect(Receipt.deserialize(targetLeg!.receipt!)).toMatchObject({ method: 'tempo', status: 'success', reference: targetLeg!.transactionHash });
    // The Tempo node got the Signer's transaction, broadcast by the target
    expect(rpc.transactions.map(hash => hash.toLowerCase())).toContain(targetLeg!.transactionHash);
    // SG-7
    const [signature] = await database.db.select().from(signatures).where(eq(signatures.id, targetLeg!.signatureId));
    expect(signature).toMatchObject({ protocol: 'mpp', network: tempoNetwork, asset: 'tempo-pathusd', atomicAmount: 1_000n, payTo: targetRecipient, quoteId: buyerLeg!.id });
    await expect.poll(async () => (await legOf('/v1/pools')).buyerLeg?.status).toBe('captured');
    // RT-12: the endpoint that answered 402 is registered
    await expect.poll(async () => (await database.db.select().from(routedEndpoints)).map(row => row.path)).toContain('/v1/pools');
  });

  it('is paid by an x402 buyer on Base, and by an MPP buyer on Tempo (RT-6, T27)', async () => {
    const { response, required } = await challengeOf('/v1/x402-buyer');
    expect(response.status).toBe(402);
    // The combined 402 at the quote: x402 on Base and Cardano, and MPP
    expect(required.accepts.map(option => option.network)).toEqual(expect.arrayContaining([base, preprod]));
    expect(response.headers.get('www-authenticate')).toMatch(/^Payment /);
    const client = new x402Client().register(base, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
    const signed = encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === base) }));

    const viaX402 = await fetch(link('/v1/x402-buyer'), { headers: { 'payment-signature': signed } });

    expect(viaX402.status).toBe(200);
    expect(viaX402.headers.get('payment-response')).not.toBeNull();
    expect(await legOf('/v1/x402-buyer')).toMatchObject({ buyerLeg: { rail: 'x402', status: 'settled', amount: 1_000n }, targetLeg: { protocol: 'mpp', status: 'settled' } });

    const payer = createTestTempoPayer({ rpcUrl: rpc.url });
    const credential = await payer.credentialFor(await fetch(link('/v1/mpp-buyer')));
    const viaMpp = await fetch(link('/v1/mpp-buyer'), { headers: { authorization: credential } });

    expect(viaMpp.status).toBe(200);
    expect(viaMpp.headers.get('payment-receipt')).not.toBeNull();
    // The buyer's credential paid us; the target got the Signer's
    expect(received.at(-1)).not.toBe(credential);
    expect(await legOf('/v1/mpp-buyer')).toMatchObject({ buyerLeg: { rail: 'mpp', status: 'settled', amount: 1_000n }, targetLeg: { protocol: 'mpp', status: 'settled' } });
  });

  it('is paid by a Cardano buyer in USDM, from $0.001 as production now offers it, for an MPP target and an x402 target on Base (RT-6, PR-3)', async () => {
    const pay = async (path: string) => {
      const { required } = await challengeOf(path);
      const option = required.accepts.find(item => item.network === preprod);
      expect(option).toMatchObject({ amount: path === '/v1/tie' ? '2000' : '1000' });
      const client = new x402Client().register(preprod, new ExactCardanoScheme(cardanoWallet.signer));

      return fetch(link(path), { headers: { 'payment-signature': encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: [option!] })) } });
    };

    const toMpp = await pay('/v1/cardano-buyer');
    const toBase = await pay('/v1/tie');

    expect(toMpp.status).toBe(200);
    expect(await toMpp.json()).toEqual({ path: '/v1/cardano-buyer', paidWith: 'mpp' });
    expect(await legOf('/v1/cardano-buyer')).toMatchObject({ buyerLeg: { rail: 'x402', network: preprod, status: 'settled' }, targetLeg: { protocol: 'mpp', network: tempoNetwork } });
    expect(toBase.status).toBe(200);
    expect(await toBase.json()).toEqual({ path: '/v1/tie', paidWith: 'x402' });
  });

  it('chooses x402 on Base at the same price, and MPP on Tempo when it is cheaper (RT-4)', async () => {
    const paying = await buyer();

    const tie = await fetch(link('/v1/tie'), { headers: { authorization: `Bearer ${paying.key}` } });
    const cheaper = await fetch(link('/v1/cheaper'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(await tie.json()).toEqual({ path: '/v1/tie', paidWith: 'x402' });
    expect(paid.at(-2)).toEqual({ path: '/v1/tie', protocol: 'x402', amount: '2000' });
    expect(await cheaper.json()).toEqual({ path: '/v1/cheaper', paidWith: 'mpp' });
    expect(paid.at(-1)).toEqual({ path: '/v1/cheaper', protocol: 'mpp', amount: '0.001' });
    expect(await balance(paying.id)).toBe(1_000_000n - 2_000n - 1_000n);
  });

  it.each([
    ['push mode only', '/v1/push-only', 'push_only'],
    ['splits', '/v1/splits', 'splits'],
    ['a currency outside the registry', '/v1/currency', 'unsupported_currency'],
    ['another chain than mpp.network', '/v1/chain', 'wrong_chain'],
  ])('refuses a challenge with %s: 502 unsupported_payment with its reason, and nobody charged (RT-4)', async (_name, path, reason) => {
    const paying = await buyer();

    const response = await fetch(link(path), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': `refused-${reason}` } });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_payment' } });
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(lines.find(line => line['requestId'] === `refused-${reason}` && line['msg'] === 'The routed target offers no payment we make')).toMatchObject({
      code: 'unsupported_payment', offered: ['mpp tempo.charge'], reasons: [reason],
    });
  });

  it('refuses above the per-call maximum and without SIGNER_TEMPO_KEY: 503, the Signer\'s reason in the log, and nobody charged (SG-1, SG-3)', async () => {
    const paying = await buyer();

    const expensive = await fetch(link('/v1/expensive'), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'mpp-expensive' } });
    const noWallet = await fetch(link('/v1/no-wallet', noTempoUrl), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'mpp-no-wallet' } });

    expect([expensive.status, noWallet.status]).toEqual([503, 503]);
    expect(await balance(paying.id)).toBe(1_000_000n);
    const refusal = (requestId: string) => lines.find(line => line['requestId'] === requestId && line['msg'] === 'The Signer didn\'t sign a routed payment');
    expect(refusal('mpp-expensive')).toMatchObject({ protocol: 'mpp', network: tempoNetwork, code: 'signing_refused', reason: 'The amount is above the per-call maximum' });
    expect(refusal('mpp-no-wallet')).toMatchObject({ protocol: 'mpp', code: 'signing_refused', reason: 'The Signer holds no wallet on Tempo Moderato' });
    expect(lines.find(line => line['requestId'] === 'mpp-no-wallet' && line['msg'] === 'Refused to sign a routed payment')).toMatchObject({ reason: 'no_wallet' });
  });

  it('refuses a target that asks more on the paid retry: 502 quote_exceeded, nothing broadcast, nobody charged (RT-8)', async () => {
    const paying = await buyer();
    const before = rpc.transactions.length;

    const response = await fetch(link('/v1/pricier'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'quote_exceeded' } });
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(rpc.transactions.length).toBe(before);
    expect((await legOf('/v1/pricier')).targetLeg).toMatchObject({ protocol: 'mpp', status: 'failed' });
  });

  it('books one routing loss when the target answers 5xx with a Payment-Receipt, which the routing_losses job doesn\'t book again (RT-9)', async () => {
    const paying = await buyer();
    const before = await routingLossesBalance();

    const response = await fetch(link('/v1/broken'), { headers: { authorization: `Bearer ${paying.key}` } });
    const book = createRoutingLosses({
      routing: createRoutingRepository({ db: database.db, clock }), ledger: ledger(), metrics: createRoutingLossMetrics(new Registry()), logger: createLogger({ level: 'silent' }),
    });

    expect(response.status).toBe(503);
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(await book()).toEqual({ booked: 0, failed: 0 });
    expect(await routingLossesBalance() - before).toBe(-1_000n);
    expect((await legOf('/v1/broken')).targetLeg).toMatchObject({ protocol: 'mpp', status: 'settled', lossBooked: true, receipt: expect.any(String) });
  });

  it('books an MPP target\'s routing loss through the routing_losses job when the buyer\'s settlement fails after the target was paid (RT-9, P-9)', async () => {
    const { required } = await challengeOf('/v1/drained');
    const client = new x402Client().register(base, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
    const signed = encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === base) }));
    const before = await routingLossesBalance();
    cdp.handle('/settle', () => ({ status: 200, body: { success: false, errorReason: 'insufficient_funds', transaction: '', network: base } }));
    let response: Response;
    try {
      response = await fetch(link('/v1/drained'), { headers: { 'payment-signature': signed } });
    }
    finally {
      cdp.reset();
    }
    const book = createRoutingLosses({
      routing: createRoutingRepository({ db: database.db, clock }), ledger: ledger(), metrics: createRoutingLossMetrics(new Registry()), logger: createLogger({ level: 'silent' }),
    });

    expect(response.status).toBe(502);
    expect(await legOf('/v1/drained')).toMatchObject({ buyerLeg: { rail: 'x402', status: 'failed' }, targetLeg: { protocol: 'mpp', status: 'settled', lossBooked: false } });
    expect(await book()).toEqual({ booked: 1, failed: 0 });
    expect(await book()).toEqual({ booked: 0, failed: 0 });
    expect(await routingLossesBalance() - before).toBe(-1_000n);
  });

  it('quotes an MPP-only target at GET /_/check without paying (RT-19)', async () => {
    const before = rpc.transactions.length;

    const checked = await (await fetch(`${proxyUrl}/_/check?url=${encodeURIComponent(`https://${targetHost}:${target.port}/v1/checked`)}`)).json();

    expect(checked).toEqual({
      payable: true, target: `https://${targetHost}:${target.port}/v1/checked`,
      price: { amount: '0.001', currency: 'USD', asset: 'tempo-pathusd', network: tempoNetwork },
      quote: { amount: '0.001', fee: '0', currency: 'USD' },
      link: `${config.urls.pay}/${targetHost}:${target.port}/v1/checked`,
    });
    expect(rpc.transactions.length).toBe(before);
  });

  it('names the protocol, network, and amount on the routing and Signer lines (L-5, L-6)', async () => {
    const paying = await buyer();
    await fetch(link('/v1/logged'), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'mpp-logged' } });
    const ofCall = (app: string, msg: string) => lines.find(line => line['requestId'] === 'mpp-logged' && line['name'] === app && line['msg'] === msg);

    expect(ofCall('proxy', 'Routing quote')).toMatchObject({ protocol: 'mpp', network: tempoNetwork, asset: 'tempo-pathusd', price: '0.001', quote: '0.001' });
    expect(ofCall('signer', 'Signed a routed payment')).toMatchObject({ protocol: 'mpp', network: tempoNetwork, amount: '0.001', maxFee: expect.any(String) });
    expect(ofCall('proxy', 'Routed call answered')).toMatchObject({ protocol: 'mpp', network: tempoNetwork, price: '0.001', targetStatus: 200, receipt: true });
  });

  it('never logs the Tempo key, a signed transaction, or a credential (rule 10, T24)', () => {
    const logged = JSON.stringify(lines);
    const credentials = received.filter(value => value.startsWith('Payment '));

    expect(credentials.length).toBeGreaterThan(3);
    for (const credential of credentials) {
      expect(logged).not.toContain(credential.slice('Payment '.length));
      expect(logged).not.toContain(Credential.deserialize<{ signature: string }>(credential).payload.signature);
    }
    expect(logged).not.toContain(signerKey.slice(2));
  });
});
