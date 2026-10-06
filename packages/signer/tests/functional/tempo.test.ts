import { Challenge, Credential } from 'mppx';
import { eq } from 'drizzle-orm';
import { decodeFunctionData, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Abis, Transaction } from 'viem/tempo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, Secret, type Server } from '@servicerouter/common';
import { findAsset, loadPlatformConfig, type PlatformConfig } from '@servicerouter/core';
import { signatures } from '@servicerouter/db';
import {
  createFakeClock, createTestDatabase, createTestRedis, startFakeTempoRpc, type FakeTempoRpc, type TestDatabase, type TestRedis,
} from '@servicerouter/testing';

import { createApp } from '../../src/app.js';
import { startSigner } from '../../src/start.js';

// T27: the Signer pays MPP targets on Tempo, in pull mode, from SIGNER_TEMPO_KEY
const secret = 'signer-secret-0123456789abcdef-0123456789';
const base = 'eip155:84532';
const tempo = 'eip155:42431';
const recipient = '0x5555555555555555555555555555555555555555';
const baseRecipient = '0x2222222222222222222222222222222222222222';
// mppx's client checks a challenge's expiry against the real clock, so the Signer's runs near it
const clock = createFakeClock(new Date().toISOString());

let database: TestDatabase;
let redis: TestRedis;
let rpc: FakeTempoRpc;
let config: PlatformConfig;
// Both wallets, and Base's only
let both: Server;
let baseOnly: Server;
let url: string;
let metricsUrl: string;
let baseOnlyUrl: string;
const walletKey = generatePrivateKey();
const wallet = privateKeyToAccount(walletKey);
const lines: Record<string, unknown>[] = [];
const capture = () => createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
const lastLine = (msg: string): Record<string, unknown> | undefined => lines.filter(line => line['msg'] === msg).at(-1);
// Every credential the Signer answered: none may reach a log
const credentials: string[] = [];

beforeAll(async () => {
  [database, redis, rpc] = await Promise.all([createTestDatabase(), createTestRedis(), startFakeTempoRpc()]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      // $0.05 a call, $0.06 a day per network, no hourly limit: small, so the tests reach them
      CONFIG: Buffer.from(JSON.stringify({ signer: { maxPerCall: '0.05', maxPerNetworkPerDay: '0.06' } })).toString('base64'),
    },
  });
  // One key for both chains, as the operator may give it: the address is the same on each
  both = createApp({ config, logger: capture(), postgres: database.postgres, redis, secret: Secret.from(secret), wallets: { base: wallet, tempo: wallet }, tempoRpcUrl: rpc.url, clock });
  baseOnly = createApp({ config, logger: capture(), postgres: database.postgres, redis, secret: Secret.from(secret), wallets: { base: wallet }, tempoRpcUrl: rpc.url, clock });
  const [bothPorts, basePorts] = await Promise.all([both.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 }), baseOnly.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })]);
  url = `http://127.0.0.1:${bothPorts.port}`;
  metricsUrl = `http://127.0.0.1:${bothPorts.metricsPort}/metrics`;
  baseOnlyUrl = `http://127.0.0.1:${basePorts.port}`;
});

afterAll(async () => {
  await Promise.all([both?.close(), baseOnly?.close()]);
  await rpc?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

let counter = 0;

/** A target's Tempo charge, as `mppx`'s server writes it, expiring in five minutes. */
const charge = (amount: string, details: Record<string, unknown> = {}, request: Record<string, unknown> = {}): string => {
  counter += 1;

  return Challenge.serialize(Challenge.from({
    id: `challenge-${counter}`, realm: 'api.target.dev', method: 'tempo', intent: 'charge', expires: new Date(clock.now().getTime() + 5 * 60_000).toISOString(),
    request: {
      amount, currency: findAsset(config, 'tempo-pathusd')!.address, recipient, methodDetails: { chainId: 42_431, supportedModes: ['pull'], ...details }, ...request,
    },
  } as never));
};

const sign = async (body: Record<string, unknown>, at = url) => {
  const response = await fetch(`${at}/internal/v1/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signer-secret': secret, 'x-request-id': String(body['requestId'] ?? 'req-tempo') },
    body: JSON.stringify({ requestId: 'req-tempo', quoteId: `pay_${Math.random()}`, url: 'https://api.target.dev/v1/pools', ...body }),
  });
  const answer = await response.json() as Record<string, any>;
  if (typeof answer['header'] === 'string')
    credentials.push(answer['header']);

  return { status: response.status, body: answer };
};

const signMpp = async (challenge: string, quotedPrice: string, at = url, requestId = 'req-tempo') => sign({ protocol: 'mpp', challenge, quotedPrice, requestId }, at);

const signBase = async (amount: string) => sign({
  protocol: 'x402', x402Version: 2, quotedPrice: amount, resource: { url: 'https://api.target.dev/v1/pools' },
  requirement: { scheme: 'exact', network: base, amount, asset: findAsset(config, 'base-usdc')!.address, payTo: baseRecipient, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } },
});

describe('the Signer pays MPP targets on Tempo (SG-1 to SG-8, T27)', () => {
  it('signs a Tempo charge in pull mode with mppx\'s client, within the quote, and records it (SG-2, SG-7, SG-8)', async () => {
    const signed = await signMpp(charge('1500'), '1500', url, 'req-tempo-1');
    const credential = Credential.deserialize<{ signature: Hex; type: string }>(signed.body['header']);
    const transaction = Transaction.deserialize(credential.payload.signature) as { from?: string; calls?: readonly { to: string; data: Hex }[]; validBefore?: number };
    const [call] = transaction.calls ?? [];
    const transfer = decodeFunctionData({ abi: Abis.tip20, data: call!.data });
    const [record] = await database.db.select().from(signatures).where(eq(signatures.id, signed.body['signatureId']));

    expect(signed.status).toBe(200);
    expect(signed.body['header']).toMatch(/^Payment /);
    expect(credential.payload.type).toBe('transaction');
    expect(credential.challenge.id).toBe(`challenge-${counter}`);
    expect(call!.to.toLowerCase()).toBe(findAsset(config, 'tempo-pathusd')!.address.toLowerCase());
    expect(transfer.args.slice(0, 2)).toEqual([recipient, 1_500n]);
    expect(transaction.validBefore! * 1_000).toBeLessThanOrEqual(Date.now() + 26_000);
    expect(signed.body).toMatchObject({ network: tempo, asset: 'tempo-pathusd', atomicAmount: '1500', amount: '1500', payTo: recipient });
    expect(record).toMatchObject({ requestId: 'req-tempo-1', protocol: 'mpp', network: tempo, asset: 'tempo-pathusd', atomicAmount: 1_500n, amount: 1_500n, payTo: recipient });
    // L-6: the protocol, network, amount, and the most our transaction pays in fees
    expect(lines.find(line => line['requestId'] === 'req-tempo-1' && line['msg'] === 'Signed a routed payment')).toMatchObject({
      protocol: 'mpp', network: tempo, asset: 'tempo-pathusd', amount: '0.0015', payTo: recipient, maxFee: expect.stringMatching(/^0\.\d+$/), result: 'signed',
    });
    expect(await (await fetch(metricsUrl)).text()).toMatch(/signer_fees_usd_total\{network="eip155:42431"\} 0\.\d+/);
  });

  it.each([
    ['push mode only', () => charge('1000', { supportedModes: ['push'] }), 'push_only'],
    ['splits', () => charge('1000', { splits: [{ amount: '100', recipient: baseRecipient }] }), 'splits'],
    ['a currency outside the registry', () => charge('1000', {}, { currency: '0x20c0000000000000000000000000000000000001' }), 'unsupported_currency'],
    ['another chain than mpp.network', () => charge('1000', { chainId: 4_217 }), 'wrong_chain'],
    ['a challenge that isn\'t one', () => 'Payment nonsense', 'not_tempo_charge'],
  ])('refuses %s, signing nothing (SG-3)', async (_name, challenge, reason) => {
    const before = rpc.calls.length;

    expect(await signMpp(challenge(), '1000')).toMatchObject({ status: 422, body: { error: { code: 'signing_refused' } } });
    expect(lastLine('Refused to sign a routed payment')).toMatchObject({ protocol: 'mpp', result: 'refused', reason });
    expect(rpc.calls.length).toBe(before);
  });

  it('refuses above the quote and above the per-call maximum (SG-3)', async () => {
    expect(await signMpp(charge('2000'), '1999')).toMatchObject({ status: 422, body: { error: { message: 'The amount is above the quoted price' } } });
    expect(await signMpp(charge('60000'), '60000')).toMatchObject({ status: 422, body: { error: { message: 'The amount is above the per-call maximum' } } });
  });

  it('refuses every Tempo target without SIGNER_TEMPO_KEY: no_wallet (SG-1)', async () => {
    expect(await signMpp(charge('1000'), '1000', baseOnlyUrl)).toMatchObject({ status: 422, body: { error: { message: 'The Signer holds no wallet on Tempo Moderato' } } });
    expect(lastLine('Refused to sign a routed payment')).toMatchObject({ protocol: 'mpp', network: tempo, reason: 'no_wallet' });
  });

  it('counts Tempo\'s daily limit apart from Base\'s (SG-4)', async () => {
    // A new day: $0.0015 of Tempo was signed today above
    clock.advance(24 * 60 * 60_000);
    expect((await signBase('50000')).status).toBe(200);
    expect(await signBase('20000')).toMatchObject({ status: 422, body: { error: { message: 'The daily spend limit is reached' } } });

    expect((await signMpp(charge('50000'), '50000')).status).toBe(200);
    expect(await signMpp(charge('20000'), '20000')).toMatchObject({ status: 422, body: { error: { message: 'The daily spend limit is reached' } } });
    expect(lastLine('The Signer refused a payment: a spend limit is reached')).toMatchObject({
      network: tempo, refusal: 'daily_limit', spent: '0.05', limit: '0.06', alert: true,
    });
  });

  it('answers 502 signing_failed when the Tempo RPC fails, and logs its short reason (SG-2, L-6)', async () => {
    rpc.unavailable(true);
    try {
      expect(await signMpp(charge('1000'), '1000', url, 'req-tempo-down')).toMatchObject({ status: 502, body: { error: { code: 'signing_failed' } } });
    }
    finally {
      rpc.unavailable(false);
    }
    expect(lines.find(line => line['requestId'] === 'req-tempo-down' && line['msg'] === 'Failed to sign a routed payment')).toMatchObject({
      level: 40, protocol: 'mpp', result: 'failed', reason: expect.any(String),
    });
  });

  it('never logs the Tempo key, a signed transaction, or a credential (rule 10)', () => {
    const logged = JSON.stringify(lines);

    // x402's PAYMENT-SIGNATURE values, and MPP's credentials with their signed transactions
    expect(credentials.filter(credential => credential.startsWith('Payment ')).length).toBeGreaterThan(1);
    for (const credential of credentials) {
      expect(logged).not.toContain(credential);
      if (!credential.startsWith('Payment '))
        continue;
      expect(logged).not.toContain(credential.slice('Payment '.length));
      expect(logged).not.toContain(Credential.deserialize<{ signature: string }>(credential).payload.signature);
    }
    expect(logged).not.toContain(walletKey);
    expect(logged).not.toContain(walletKey.slice(2));
  });
});

describe('the Signer\'s startup with a Tempo wallet (L-1)', () => {
  it('logs both wallets\' addresses, never their keys', async () => {
    const startLines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => startLines.push(JSON.parse(line) as Record<string, unknown>) });
    const tempoKey = generatePrivateKey();
    const app = await startSigner({
      env: {
        CONFIG_PATH: 'config/example.yaml', SIGNER_SECRET: secret, SIGNER_TEMPO_KEY: tempoKey, DATABASE_URL: database.url.expose(), REDIS_URL: redis.url.expose(),
        HOST: '127.0.0.1', PORT: '0', METRICS_PORT: '0',
      },
      logger,
    });
    await app.close();

    expect(startLines.find(line => line['msg'] === 'Started')).toMatchObject({ wallets: { base: null, tempo: privateKeyToAccount(tempoKey).address } });
    expect(JSON.stringify(startLines)).not.toContain(tempoKey.slice(2));
    await expect(startSigner({ env: { CONFIG_PATH: 'config/example.yaml', SIGNER_SECRET: secret, SIGNER_TEMPO_KEY: '0x12', DATABASE_URL: database.url.expose(), REDIS_URL: redis.url.expose() }, logger }))
      .rejects.toThrow('SIGNER_TEMPO_KEY must be 0x and 64 hex characters');
  });
});
