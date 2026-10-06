import { fixtureTime } from '@servicerouter/testing';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret, type Server } from '@servicerouter/common';
import { createBlockfrostClient, createDepositAddressDeriver, createDepositWatcher, loadPlatformConfig, type PlatformConfig } from '@servicerouter/core';
import { createDepositRepository } from '@servicerouter/db';
import {
  createFakeClock, createTestDatabase, createTestDepositWallet, createTestRedis, createTestSecretKeys, startFakeBlockfrost, type FakeBlockfrost,
  type FakeClock, type TestDatabase, type TestDepositWallet, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createApp } from '../../src/app.js';

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let keys: TestSecretKeys;
let blockfrost: FakeBlockfrost;
let wallet: TestDepositWallet;
let clock: FakeClock;
let url: string;
const servers: Server[] = [];

const configWith = (rateLimits: Record<string, unknown>) => loadPlatformConfig({
  env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from(JSON.stringify({ rateLimits })).toString('base64') },
});

/** An API with the test wallet's deposit key, unless deposits are off, on its own Redis prefix when given one. */
const start = async (appConfig: PlatformConfig, appRedis: TestRedis = redis) => {
  const depositAddresses = appConfig.deposits && createDepositAddressDeriver({ accountPublicKey: wallet.accountPublicKey, network: appConfig.deposits.network });
  const server = createApp({
    config: appConfig, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis: appRedis, clock, sealer: keys.sealer,
    ...depositAddresses ? { depositAddresses } : {},
  });
  servers.push(server);
  const { port } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

  return `http://127.0.0.1:${port}`;
};

beforeAll(async () => {
  [database, redis, keys, blockfrost, config] = await Promise.all([
    createTestDatabase(), createTestRedis(), createTestSecretKeys(), startFakeBlockfrost(),
    configWith({ signup: { requests: 1000, windowSeconds: 60 }, topup: { requests: 1000, windowSeconds: 60 } }),
  ]);
  wallet = createTestDepositWallet();
  clock = createFakeClock(fixtureTime(-4, 1, 0, 0, 0, 0));
  url = await start(config);
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await blockfrost?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const signup = async (base = url) => {
  const response = await fetch(`${base}/v1/accounts`, { method: 'POST' });

  return { status: response.status, body: await response.json() as { id: string; masterKey: string; topupUrl: string | null; depositAddress: { address: string; network: string; asset: string } | null } };
};

const tokenOf = (topupUrl: string): string => topupUrl.split('/').at(-1)!;

describe('the deposit address at signup (AK-1, AK-15, DP-1)', () => {
  it('gives each new account its own address and a top-up link with a random token of its own', async () => {
    const [first, second] = [await signup(), await signup()];

    expect(first.status).toBe(201);
    expect(first.body.depositAddress).toEqual({ address: expect.stringMatching(/^addr_test1v/), network: 'cardano:preprod', asset: 'cardano-usdm' });
    expect(first.body.topupUrl).toMatch(/^https:\/\/staging\.servicerouter\.ai\/topup\/[A-Za-z0-9_-]{32}$/);
    expect(second.body.depositAddress!.address).not.toBe(first.body.depositAddress!.address);
    expect(tokenOf(second.body.topupUrl!)).not.toBe(tokenOf(first.body.topupUrl!));
    // The token is no key: it isn't derived from the master key
    expect(first.body.topupUrl).not.toContain(first.body.masterKey.slice(-20));
  });

  it('shows the same address and link on GET /v1/account, and the holder of the mnemonic spends from it', async () => {
    const created = await signup();
    const account = await (await fetch(`${url}/v1/account`, { headers: { authorization: `Bearer ${created.body.masterKey}` } })).json() as typeof created.body;
    const row = await createDepositRepository({ db: database.db, clock, ids: randomIdGenerator }).findAddress(created.body.id);

    expect(account.depositAddress).toEqual(created.body.depositAddress);
    expect(account.topupUrl).toBe(created.body.topupUrl);
    expect(createDepositAddressDeriver({ accountPublicKey: wallet.accountPublicKey, network: config.deposits!.network })(row!.derivationIndex)).toBe(row!.address);
  });

  it('gives no address or link while deposits are off', async () => {
    const off = await start(await loadPlatformConfig({
      env: {
        CONFIG_PATH: 'config/example.yaml',
        CONFIG: Buffer.from(JSON.stringify({ deposits: { asset: 'cardano-usdm', enabled: false }, rateLimits: { signup: { requests: 1000, windowSeconds: 60 } } })).toString('base64'),
      },
    }));

    const created = await signup(off);

    expect(created.body).toMatchObject({ topupUrl: null, depositAddress: null });
  });
});

describe('GET /v1/topup/{token} (DP-5, PA-2, PA-5)', () => {
  it('shows the address, the asset, and the deposits with their confirmations, without a key', async () => {
    const created = await signup();
    const address = created.body.depositAddress!.address;
    const usdm = config.deposits!.asset.address;
    const credited = blockfrost.send([{ address, value: { lovelace: 1_500_000n, assets: { [usdm]: 10_000_000n } } }]);
    blockfrost.addBlocks(20);
    const confirming = blockfrost.send([{ address, value: { lovelace: 1_500_000n, assets: { [usdm]: 2_500_000n } } }]);
    blockfrost.addBlocks(2);
    const ada = blockfrost.send([{ address, value: { lovelace: 3_000_000n } }]);
    await createDepositWatcher({
      store: createDepositRepository({ db: database.db, clock, ids: randomIdGenerator }),
      blockfrost: createBlockfrostClient({ url: blockfrost.url, projectId: Secret.from('preprodTestProjectId'), timeoutMs: 2_000 }),
      clock,
      logger: createLogger({ level: 'silent' }),
      asset: config.deposits!.asset,
      confirmations: config.deposits!.confirmations,
    })({ limit: 100 });

    const response = await fetch(`${url}/v1/topup/${tokenOf(created.body.topupUrl!)}`);
    const body = await response.json() as { deposits: { transactionHash: string }[] };

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({
      address,
      asset: { name: 'cardano-usdm', symbol: 'USDM', network: 'cardano:preprod', networkTitle: 'Cardano Preprod' },
      confirmationsRequired: 15,
    });
    expect(body.deposits).toEqual([
      expect.objectContaining({ transactionHash: ada, amount: null, status: 'not_credited' }),
      expect.objectContaining({ transactionHash: confirming, amount: '2.5', status: 'confirming', confirmations: 3, confirmationsRequired: 15, creditedAt: null }),
      expect.objectContaining({ transactionHash: credited, amount: '10', status: 'credited', confirmations: 15, creditedAt: expect.any(String) }),
    ]);
    // The balance shows the credited deposit only
    const balance = await (await fetch(`${url}/v1/balance`, { headers: { authorization: `Bearer ${created.body.masterKey}` } })).json() as { available: string };
    expect(balance.available).toBe('10');
  });

  it('answers 404 for an unknown or malformed token', async () => {
    expect((await fetch(`${url}/v1/topup/${'A'.repeat(32)}`)).status).toBe(404);
    expect((await fetch(`${url}/v1/topup/not-a-token`)).status).toBe(404);
  });

  it('limits requests per client IP: 429 rate_limited with Retry-After', async () => {
    // A Redis prefix of its own, so the other tests' requests don't count
    const ownRedis = await createTestRedis();
    const limited = await start(await configWith({ signup: { requests: 1000, windowSeconds: 60 }, topup: { requests: 2, windowSeconds: 60 } }), ownRedis);
    const token = 'B'.repeat(32);

    const answers = [await fetch(`${limited}/v1/topup/${token}`), await fetch(`${limited}/v1/topup/${token}`), await fetch(`${limited}/v1/topup/${token}`)];

    expect(answers.map(answer => answer.status)).toEqual([404, 404, 429]);
    expect(answers[2]!.headers.get('retry-after')).toMatch(/^\d+$/);
    await servers.pop()!.close();
    await ownRedis.cleanup();
  });
});
