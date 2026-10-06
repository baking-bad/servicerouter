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

const secret = 'signer-secret-0123456789abcdef-0123456789';
const base = 'eip155:84532';
const payTo = '0x2222222222222222222222222222222222222222';
const clock = createFakeClock(fixtureTime(0, 6, 10, 15, 0, 0));

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let server: Server;
let url: string;
const wallet = privateKeyToAccount(generatePrivateKey());

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      // $0.05 per call, $0.06 an hour, $0.10 a day: small, so the tests reach them
      CONFIG: Buffer.from(JSON.stringify({ signer: { maxPerCall: '0.05', maxPerNetworkPerHour: '0.06', maxPerNetworkPerDay: '0.1' } })).toString('base64'),
    },
  });
  server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, secret: Secret.from(secret), wallets: { base: wallet }, clock });
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
