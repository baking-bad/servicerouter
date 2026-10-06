import { fixtureTime } from '@servicerouter/testing';

import { decodePaymentSignatureHeader } from '@x402/core/http';
import { eq } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, Secret, type Server } from '@servicerouter/common';
import { findAsset, loadPlatformConfig, type PlatformConfig } from '@servicerouter/core';
import { signatures } from '@servicerouter/db';
import { createFakeClock, createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '@servicerouter/testing';

import { createApp } from '../../src/app.js';
import { startSigner } from '../../src/start.js';

const secret = 'signer-secret-0123456789abcdef-0123456789';
const base = 'eip155:84532';
const payTo = '0x2222222222222222222222222222222222222222';
const clock = createFakeClock(fixtureTime(0, 6, 10, 15, 0, 0));

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let server: Server;
let url: string;
const walletKey = generatePrivateKey();
const wallet = privateKeyToAccount(walletKey);
// Every line the Signer writes, debug included (T24)
const lines: Record<string, unknown>[] = [];
const capture = () => createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      // $0.05 per call, $0.06 an hour, $0.10 a day: small, so the tests reach them
      CONFIG: Buffer.from(JSON.stringify({ signer: { maxPerCall: '0.05', maxPerNetworkPerHour: '0.06', maxPerNetworkPerDay: '0.1' } })).toString('base64'),
    },
  });
  server = createApp({ config, logger: capture(), postgres: database.postgres, redis, secret: Secret.from(secret), wallets: { base: wallet }, clock });
  url = `http://127.0.0.1:${(await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
});

afterAll(async () => {
  await server?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const option = (amount: string, overrides: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: base, amount, asset: findAsset(config, 'base-usdc')!.address, payTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' }, ...overrides,
});

const sign = async (amount: string, { quotedPrice = amount, overrides = {}, key = secret } = {} as { quotedPrice?: string; overrides?: Record<string, unknown>; key?: string }) => {
  const response = await fetch(`${url}/internal/v1/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signer-secret': key },
    body: JSON.stringify({
      requestId: 'req-1', quoteId: `pay_${amount}_${Math.random()}`, x402Version: 2, requirement: option(amount, overrides),
      resource: { url: 'https://api.target.dev/v1/pools' }, url: 'https://api.target.dev/v1/pools', quotedPrice,
    }),
  });

  return { status: response.status, body: await response.json() as Record<string, any> };
};

describe('the Signer (SG-2 to SG-8, step 12)', () => {
  it('signs an x402 payment with the official client, within the quote, and records it (SG-2, SG-7, SG-8)', async () => {
    const signed = await sign('10000');
    const payload = decodePaymentSignatureHeader(signed.body['header']) as unknown as { payload: { authorization: { from: string; to: string; value: string } } };
    const [record] = await database.db.select().from(signatures).where(eq(signatures.id, signed.body['signatureId']));

    expect(signed.status).toBe(200);
    expect(payload.payload.authorization).toMatchObject({ from: wallet.address, to: payTo, value: '10000' });
    expect(record).toMatchObject({ requestId: 'req-1', protocol: 'x402', network: base, asset: 'base-usdc', atomicAmount: 10_000n, amount: 10_000n, payTo });
  });

  it('refuses above the quote, above the per-call maximum, and outside the registry (SG-3)', async () => {
    expect(await sign('20000', { quotedPrice: '19999' })).toMatchObject({ status: 422, body: { error: { code: 'signing_refused', message: 'The amount is above the quoted price' } } });
    expect(await sign('60000')).toMatchObject({ status: 422, body: { error: { message: 'The amount is above the per-call maximum' } } });
    expect(await sign('1000', { overrides: { asset: '0x3333333333333333333333333333333333333333' } })).toMatchObject({ status: 422, body: { error: { message: 'The network and asset aren\'t in the registry' } } });
    expect(await sign('1000', { overrides: { network: 'eip155:1' } })).toMatchObject({ status: 422 });
    expect(await sign('1000', { overrides: { extra: { name: 'USDC', version: '2' }, scheme: 'upto' } })).toMatchObject({ status: 422 });
  });

  it('stops at the spend limits per network: the hour first, then the day (SG-4)', async () => {
    // $0.01 was signed above: $0.05 more fills the hour's $0.06
    expect((await sign('50000')).status).toBe(200);
    expect(await sign('1000')).toMatchObject({ status: 422, body: { error: { message: 'The hourly spend limit is reached' } } });
    clock.advance(60 * 60_000);
    expect((await sign('30000')).status).toBe(200);
    expect(await sign('20000')).toMatchObject({ status: 422, body: { error: { message: 'The daily spend limit is reached' } } });
  });

  it('refuses a request without the shared secret (SG-2) and answers readiness with Postgres and Redis', async () => {
    expect((await sign('1000', { key: 'wrong' })).status).toBe(401);
    expect(await (await fetch(`${url}/_/ready`)).json()).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });
});

describe('the Signer\'s lines (L-6)', () => {
  const signAs = async (requestId: string, amount: string, quotedPrice = amount) => {
    const response = await fetch(`${url}/internal/v1/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signer-secret': secret, 'x-request-id': requestId },
      body: JSON.stringify({
        requestId, quoteId: `pay_${requestId}`, x402Version: 2, requirement: option(amount), resource: { url: 'https://api.target.dev/v1/pools' },
        url: 'https://api.target.dev/v1/pools', quotedPrice,
      }),
    });

    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const linesOf = (requestId: string) => lines.filter(line => line['requestId'] === requestId);

  it('logs each sign request at info with its request ID, quote, network, asset, amount, payTo, and result, never the signature', async () => {
    // A new day: fresh spend windows
    clock.advance(24 * 60 * 60_000);

    const signed = await signAs('sign-log-1', '10000');
    const refused = await signAs('sign-log-2', '20000', '19999');

    expect(signed.status).toBe(200);
    expect(linesOf('sign-log-1').find(line => line['msg'] === 'Signed a routed payment')).toMatchObject({
      level: 30, quoteId: 'pay_sign-log-1', network: base, asset: 'base-usdc', amount: '0.01', atomicAmount: '10000', payTo, signatureId: signed.body['signatureId'],
      result: 'signed', durationMs: expect.any(Number),
    });
    expect(refused.status).toBe(422);
    expect(linesOf('sign-log-2').find(line => line['msg'] === 'Refused to sign a routed payment')).toMatchObject({
      level: 30, quoteId: 'pay_sign-log-2', network: base, atomicAmount: '20000', payTo, quotedPrice: '0.019999', result: 'refused', reason: 'above_quote',
      message: 'The amount is above the quoted price',
    });
    expect(JSON.stringify(lines)).not.toContain(signed.body['header']);
  });

  it('logs a spend limit\'s refusal with the window\'s total against its limit, and alerts', async () => {
    clock.advance(24 * 60 * 60_000);
    expect((await signAs('spend-log-1', '50000')).status).toBe(200);

    expect((await signAs('spend-log-2', '20000')).status).toBe(422);

    expect(linesOf('spend-log-2').find(line => line['msg'] === 'The Signer refused a payment: a spend limit is reached')).toMatchObject({
      level: 50, network: base, refusal: 'hourly_limit', amount: '0.02', window: 'hour', spent: '0.05', limit: '0.06', alert: true,
    });
    expect(linesOf('spend-log-2').find(line => line['msg'] === 'Refused to sign a routed payment')).toMatchObject({
      level: 30, result: 'refused', reason: 'hourly_limit', window: 'hour', spent: '0.05', limit: '0.06',
    });
  });

  it('never logs the shared secret, the wallet\'s key, or a signed payment', async () => {
    const signed = await signAs('secrets-1', '1000');
    await fetch(`${url}/internal/v1/sign`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signer-secret': 'wrong-secret-value' }, body: '{}' });

    const logged = JSON.stringify(lines);
    for (const value of [secret, walletKey, walletKey.slice(2), signed.body['header'], 'wrong-secret-value'])
      expect(logged).not.toContain(value);
  });
});

describe('the Signer\'s startup (L-1, L-11)', () => {
  it('logs one line with the commit, its wallet\'s address, and its limits, at LOG_LEVEL, never the key or the secret', async () => {
    const startLines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => startLines.push(JSON.parse(line) as Record<string, unknown>) });
    const env = {
      CONFIG_PATH: 'config/example.yaml', SIGNER_SECRET: secret, SIGNER_BASE_KEY: walletKey, DATABASE_URL: database.url.expose(), REDIS_URL: redis.url.expose(),
      HOST: '127.0.0.1', PORT: '0', METRICS_PORT: '0', LOG_LEVEL: 'warn', GIT_SHA: '0123456789abcdef0123456789abcdef01234567',
    };

    const app = await startSigner({ env: { ...env, LOG_LEVEL: 'info' }, logger });
    await app.close();
    const quiet = await startSigner({ env, logger });
    await quiet.close();

    expect(startLines.filter(line => line['msg'] === 'Started')).toEqual([expect.objectContaining({
      level: 30, app: 'signer', commit: '0123456789abcdef0123456789abcdef01234567', logLevel: 'info', environment: 'staging', wallets: { base: wallet.address, tempo: null },
      limits: { maxPerCall: '1', maxPerNetworkPerHour: null, maxPerNetworkPerDay: '100' }, ports: { port: expect.any(Number), metricsPort: expect.any(Number) },
    })]);
    expect(logger.level).toBe('warn');
    const logged = JSON.stringify(startLines);
    for (const value of [secret, walletKey, walletKey.slice(2), database.url.expose()])
      expect(logged).not.toContain(value);
  });
});
