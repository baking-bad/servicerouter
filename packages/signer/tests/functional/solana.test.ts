import { fixtureTime } from '@servicerouter/testing';

import { generateKeyPairSync } from 'node:crypto';
import { createServer as createNetServer, type AddressInfo } from 'node:net';

import { createKeyPairSignerFromBytes, generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { eq } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, Secret, type Server } from '@servicerouter/common';
import { findAsset, loadPlatformConfig, type PlatformConfig } from '@servicerouter/core';
import { signatures } from '@servicerouter/db';
import {
  associatedTokenAddress, createFakeClock, createTestDatabase, createTestRedis, decodeSolanaPayment, encodeBase58, startFakeSolanaRpc, type FakeSolanaRpc,
  type TestDatabase, type TestRedis,
} from '@servicerouter/testing';

import { createApp } from '../../src/app.js';
import { startSigner } from '../../src/start.js';

// T29 (P-6): the Signer pays x402 targets on Solana from its Solana hot wallet, with @x402/svm's client.
// The target's facilitator pays the transaction's fee: our wallet only signs the USDC transfer.

const secret = 'signer-secret-0123456789abcdef-0123456789';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const base = 'eip155:84532';
const payTo = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const feePayer = encodeBase58(Uint8Array.from({ length: 32 }, () => 9));
// The key NOWNodes puts in the RPC's path: no log line may hold it
const rpcKey = 'signer-solana-key-secret';
const clock = createFakeClock(fixtureTime(0, 7, 10, 15, 0, 0));

let database: TestDatabase;
let redis: TestRedis;
let rpc: FakeSolanaRpc;
let config: PlatformConfig;
let server: Server;
let noSolana: Server;
let url: string;
let noSolanaUrl: string;
let wallet: KeyPairSigner;
const baseWallet = privateKeyToAccount(generatePrivateKey());
// The signed transactions the Signer answered: none may reach a log
const transactions: string[] = [];
const lines: Record<string, unknown>[] = [];
const capture = () => createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

/** A Solana secret key as its 64 bytes, the seed then the public key, made in the test. */
const solanaKeyBytes = (): Uint8Array => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

  return Uint8Array.from([...seed, ...raw]);
};

const closedPort = async (): Promise<number> => {
  const listener = createNetServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise(resolve => listener.close(resolve));

  return port;
};

beforeAll(async () => {
  [database, redis, rpc, wallet] = await Promise.all([createTestDatabase(), createTestRedis(), startFakeSolanaRpc(), generateKeyPairSigner()]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      // $0.05 per call and $0.10 a day per network, so the tests reach them
      CONFIG: Buffer.from(JSON.stringify({ signer: { maxPerCall: '0.05', maxPerNetworkPerDay: '0.1' } })).toString('base64'),
    },
  });
  const dependencies = { config, logger: capture(), postgres: database.postgres, redis, secret: Secret.from(secret), clock };
  server = createApp({ ...dependencies, wallets: { base: baseWallet, solana: wallet }, solanaRpcUrl: Secret.from(`${rpc.url}/${rpcKey}`) });
  noSolana = createApp({ ...dependencies, wallets: { base: baseWallet } });
  const listen = { host: '127.0.0.1', port: 0, metricsPort: 0 };
  const [ports, noSolanaPorts] = await Promise.all([server.listen(listen), noSolana.listen(listen)]);
  url = `http://127.0.0.1:${ports.port}`;
  noSolanaUrl = `http://127.0.0.1:${noSolanaPorts.port}`;
});

afterAll(async () => {
  await Promise.all([server?.close(), noSolana?.close(), rpc?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const solanaOption = (amount: string, overrides: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: solana, amount, asset: findAsset(config, 'solana-usdc')!.address, payTo, maxTimeoutSeconds: 60, extra: { feePayer }, ...overrides,
});

const baseOption = (amount: string) => ({
  scheme: 'exact', network: base, amount, asset: findAsset(config, 'base-usdc')!.address, payTo: '0x2222222222222222222222222222222222222222', maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' },
});

const sign = async (requirement: Record<string, unknown>, { quotedPrice = String(requirement['amount']), at = url, requestId = 'req-solana' } = {}) => {
  const response = await fetch(`${at}/internal/v1/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signer-secret': secret, 'x-request-id': requestId },
    body: JSON.stringify({
      requestId, quoteId: `pay_${Math.random()}`, x402Version: 2, requirement, resource: { url: 'https://api.target.dev/v1/slot' }, url: 'https://api.target.dev/v1/slot',
      quotedPrice,
    }),
  });
  const body = await response.json() as Record<string, any>;
  if (typeof body['header'] === 'string')
    transactions.push((decodePaymentSignatureHeader(body['header']) as unknown as { payload: { transaction: string } }).payload.transaction);

  return { status: response.status, body };
};

describe('the Signer on Solana (SG-1 to SG-8, T29)', () => {
  it('signs a USDC transfer with @x402/svm\'s client: the target\'s facilitator pays the fee, our wallet only signs, and the signature is recorded (SG-2, SG-7, SG-8)', async () => {
    const mint = findAsset(config, 'solana-usdc')!.address;

    const signed = await sign(solanaOption('10000'));

    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ network: solana, asset: 'solana-usdc', atomicAmount: '10000', amount: '10000', payTo });
    const payment = decodeSolanaPayment(transactions.at(-1)!);
    expect(payment.feePayer).toBe(feePayer);
    expect(payment.signedBy).toEqual([wallet.address]);
    expect(payment.unsignedBy).toEqual([feePayer]);
    expect(payment.transfer).toEqual({
      source: await associatedTokenAddress(wallet.address, mint), mint, destination: await associatedTokenAddress(payTo, mint), authority: wallet.address, amount: 10_000n, decimals: 6,
    });
    // The SDK read the mint and a recent blockhash through SOLANA_RPC_URL, with its key in the path
    expect(rpc.calls).toEqual(expect.arrayContaining(['getAccountInfo', 'getLatestBlockhash']));
    const [record] = await database.db.select().from(signatures).where(eq(signatures.id, signed.body['signatureId']));
    expect(record).toMatchObject({ requestId: 'req-solana', protocol: 'x402', network: solana, asset: 'solana-usdc', atomicAmount: 10_000n, amount: 10_000n, payTo });
  });

  it('refuses an option without a fee payer, or whose fee payer is our wallet, before the spend limits count it (SG-3)', async () => {
    expect(await sign(solanaOption('1000', { extra: {} }))).toMatchObject({
      status: 422, body: { error: { code: 'signing_refused', message: 'The Solana option names no fee payer: the Signer never pays a transaction\'s fee' } },
    });
    expect(await sign(solanaOption('1000', { extra: { feePayer: wallet.address } }))).toMatchObject({
      status: 422, body: { error: { message: 'The Solana option names our wallet as its fee payer' } },
    });
    expect(lines.filter(line => line['msg'] === 'Refused to sign a routed payment').map(line => line['reason'])).toEqual(expect.arrayContaining(['no_fee_payer', 'fee_payer_is_us']));

    // A new day's $0.10: three refused $0.05 options would pass it if the limits had counted them
    clock.advance(24 * 60 * 60_000);
    for (const extra of [{}, { feePayer: wallet.address }, {}])
      expect((await sign(solanaOption('50000', { extra }))).status).toBe(422);
    expect((await sign(solanaOption('50000'))).status).toBe(200);
    expect((await sign(solanaOption('50000'))).status).toBe(200);
  });

  it('refuses outside the registry, above the quote, and above the per-call maximum (SG-3)', async () => {
    expect(await sign(solanaOption('1000', { asset: 'So11111111111111111111111111111111111111112' }))).toMatchObject({
      status: 422, body: { error: { message: 'The network and asset aren\'t in the registry' } },
    });
    expect(await sign(solanaOption('20000'), { quotedPrice: '19999' })).toMatchObject({ status: 422, body: { error: { message: 'The amount is above the quoted price' } } });
    expect(await sign(solanaOption('60000'))).toMatchObject({ status: 422, body: { error: { message: 'The amount is above the per-call maximum' } } });
  });

  it('counts Solana\'s daily limit apart from Base\'s (SG-4)', async () => {
    // A new day: $0.01 of Solana's $0.10 was spent above, on another day
    clock.advance(24 * 60 * 60_000);
    expect((await sign(solanaOption('50000'))).status).toBe(200);
    expect((await sign(solanaOption('50000'))).status).toBe(200);
    expect(await sign(solanaOption('1000'))).toMatchObject({ status: 422, body: { error: { message: 'The daily spend limit is reached' } } });

    expect((await sign(baseOption('50000'))).status).toBe(200);
  });

  it('refuses every Solana option without a Solana wallet (no_wallet)', async () => {
    expect(await sign(solanaOption('1000'), { at: noSolanaUrl })).toMatchObject({ status: 422, body: { error: { message: 'The Signer holds no wallet on Solana Devnet' } } });
    expect(lines.filter(line => line['msg'] === 'Refused to sign a routed payment').map(line => line['reason'])).toContain('no_wallet');
  });

  it('answers 502 signing_failed when the Solana RPC fails, with its short reason and never the RPC\'s key (SG-2, L-6)', async () => {
    clock.advance(24 * 60 * 60_000);
    const port = await closedPort();
    const down = createApp({
      config, logger: capture(), postgres: database.postgres, redis, secret: Secret.from(secret), clock, wallets: { solana: await generateKeyPairSigner() },
      solanaRpcUrl: Secret.from(`http://127.0.0.1:${port}/${rpcKey}`),
    });
    const downUrl = `http://127.0.0.1:${(await down.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
    try {
      expect(await sign(solanaOption('1000'), { at: downUrl, requestId: 'req-solana-down' })).toMatchObject({
        status: 502, body: { error: { code: 'signing_failed', message: 'The Signer couldn\'t build the Solana Devnet payment: the Solana Devnet RPC failed' } },
      });
    }
    finally {
      await down.close();
    }
    expect(lines.find(line => line['requestId'] === 'req-solana-down' && line['msg'] === 'Failed to sign a routed payment')).toMatchObject({
      level: 40, protocol: 'x402', network: solana, result: 'failed', reason: expect.any(String),
    });
  });

  it('never logs the RPC\'s key, a signed transaction, or the wallet\'s key (rule 10, L-9)', () => {
    const logged = JSON.stringify(lines);

    expect(transactions.length).toBeGreaterThan(2);
    for (const transaction of transactions)
      expect(logged).not.toContain(transaction);
    expect(logged).not.toContain(rpcKey);
  });
});

describe('the Signer\'s startup with a Solana wallet (SG-1, L-1)', () => {
  const envWith = (key: string, extra: Record<string, string> = {}) => ({
    CONFIG_PATH: 'config/example.yaml', SIGNER_SECRET: secret, SIGNER_SOLANA_KEY: key, DATABASE_URL: database.url.expose(), REDIS_URL: redis.url.expose(),
    HOST: '127.0.0.1', PORT: '0', METRICS_PORT: '0', SOLANA_RPC_URL: `https://sol.example/${rpcKey}`, ...extra,
  });

  it('takes SIGNER_SOLANA_KEY in base58 and as a JSON array, with the same address, and logs it and the RPC\'s host, never the key', async () => {
    const bytes = solanaKeyBytes();
    const address = (await createKeyPairSignerFromBytes(Uint8Array.from(bytes))).address;
    const base58 = encodeBase58(bytes);
    const array = JSON.stringify([...bytes]);
    const startLines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => startLines.push(JSON.parse(line) as Record<string, unknown>) });

    for (const key of [base58, array]) {
      const app = await startSigner({ env: envWith(key), logger });
      await app.close();
    }

    expect(startLines.filter(line => line['msg'] === 'Started')).toEqual([
      expect.objectContaining({ wallets: { base: null, tempo: null, solana: address }, solanaRpc: 'sol.example' }),
      expect.objectContaining({ wallets: { base: null, tempo: null, solana: address }, solanaRpc: 'sol.example' }),
    ]);
    const logged = JSON.stringify(startLines);
    for (const value of [base58, array, rpcKey])
      expect(logged).not.toContain(value);
  });

  it('won\'t start when the key\'s address isn\'t signer.wallets.solana, or the key isn\'t a 64-byte Solana key, without echoing it', async () => {
    const bytes = solanaKeyBytes();
    const base58 = encodeBase58(bytes);
    const other = (await generateKeyPairSigner()).address;
    const logger = createLogger({ level: 'silent' });
    const withWallet = { CONFIG: Buffer.from(JSON.stringify({ signer: { wallets: { solana: other } } })).toString('base64') };

    await expect(startSigner({ env: envWith(base58, withWallet), logger })).rejects.toThrow(/^SIGNER_SOLANA_KEY's address, \w+, isn't signer\.wallets\.solana, \w+$/);
    for (const invalid of [base58.slice(0, 40), '[1,2,3]', 'not-base58-0OIl', `[${[...bytes.slice(0, 32), ...bytes.slice(0, 32)].join(',')}]`]) {
      const failure = await startSigner({ env: envWith(invalid), logger }).then(() => undefined, (error: unknown) => error as Error);

      expect(failure?.message).toMatch(/^SIGNER_SOLANA_KEY (must be a 64-byte Solana secret key|is not a valid Solana key pair)/);
      expect(failure?.message).not.toContain(invalid);
    }
  });
});
