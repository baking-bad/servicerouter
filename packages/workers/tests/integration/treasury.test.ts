import { fixtureTime } from '@servicerouter/testing';

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Registry } from '@prometheus-io/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret, type MicroUsd } from '@servicerouter/common';
import { createBlockfrostClient, findAsset, loadPlatformConfig, treasuryWallets, type PlatformConfig } from '@servicerouter/core';
import { createLedger, reconciliationRuns } from '@servicerouter/db';
import {
  createFakeClock, createTestDatabase, startFakeBlockfrost, startFakeSolanaRpc, type FakeBlockfrost, type FakeSolanaRpc, type TestDatabase,
} from '@servicerouter/testing';

import { createReconciliationJob, createTreasuryBalancesJob, createTreasuryMetrics } from '../../src/treasury/jobs.js';
import { createCardanoBalanceReader, createEvmBalanceReader, createSolanaBalanceReader, readerFor } from '../../src/treasury/readers.js';

const clock = createFakeClock(fixtureTime(1, 2, 0, 0, 0, 0));
const logs: Record<string, unknown>[] = [];
const logger = createLogger({}, { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) });

let database: TestDatabase;
let blockfrost: FakeBlockfrost;
let config: PlatformConfig;
let evm: { url: string; close(): Promise<void>; balances: Map<string, bigint> };
let solana: FakeSolanaRpc;

/** A JSON-RPC that answers ERC-20 balanceOf calls from a map, by holder address. */
const startFakeEvmRpc = async () => {
  const balances = new Map<string, bigint>();
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => body += chunk);
    request.on('end', () => {
      const call = JSON.parse(body) as { id: number; method: string; params: [{ data: string }] };
      const holder = `0x${call.params[0].data.slice(34, 74)}`.toLowerCase();
      const result = `0x${(balances.get(holder) ?? 0n).toString(16).padStart(64, '0')}`;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    balances,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};

beforeAll(async () => {
  [database, blockfrost, config, evm, solana] = await Promise.all([
    createTestDatabase(), startFakeBlockfrost(), loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } }), startFakeEvmRpc(), startFakeSolanaRpc(),
  ]);
});

afterAll(async () => {
  await Promise.all([blockfrost?.close(), evm?.close(), solana?.close()]);
  await database?.drop();
});

const readers = () => readerFor({
  cardano: createCardanoBalanceReader(createBlockfrostClient({ url: blockfrost.url, projectId: Secret.from('preprodTestProjectId'), timeoutMs: 2_000 })),
  evm: createEvmBalanceReader({ rpcUrlFor: network => network === 'eip155:84532' ? evm.url : undefined, timeoutMs: 2_000 }),
});

describe('the treasury jobs (TR-3, TR-5)', () => {
  it('reports each wallet\'s holdings as a metric, read from Blockfrost and the EVM RPC (TR-3)', async () => {
    const usdm = findAsset(config, 'cardano-usdm')!;
    const usdc = findAsset(config, 'base-usdc')!;
    blockfrost.fund(usdm.payTo, { lovelace: 2_000_000n, assets: { [usdm.address]: 40_000_000n } });
    evm.balances.set(usdc.payTo.toLowerCase(), 12_500_000n);
    const registry = new Registry();
    const metrics = createTreasuryMetrics(registry);
    const wallets = async () => treasuryWallets({ ...config, assets: config.assets.filter(asset => asset.name === 'cardano-usdm' || asset.name === 'base-usdc') });

    await createTreasuryBalancesJob({ wallets, readerFor: readers(), payouts: undefined, signerDailyLimit: config.signer.maxPerNetworkPerDay, metrics, logger })();

    const text = await registry.metrics();
    expect(text).toMatch(/treasury_balance_usd\{wallet="payTo:cardano-usdm",asset="cardano-usdm"\} 40/);
    expect(text).toMatch(/treasury_balance_usd\{wallet="payTo:base-usdc",asset="base-usdc"\} 12\.5/);
  });

  it('stores each reconciliation, and alerts when the chain holds other than the ledger says (TR-5)', async () => {
    const ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
    // The ledger knows of 40 USDM and 10 USDC: the chain holds 40 and 12.5
    await ledger.treasuryTransfer({ reference: 'seed-usdm', from: { asset: 'seed', amount: 40_000_000n as MicroUsd }, to: { asset: 'cardano-usdm', amount: 40_000_000n as MicroUsd } });
    await ledger.treasuryTransfer({ reference: 'seed-usdc', from: { asset: 'seed', amount: 10_000_000n as MicroUsd }, to: { asset: 'base-usdc', amount: 10_000_000n as MicroUsd } });
    const registry = new Registry();
    const assets = config.assets.filter(asset => asset.name === 'cardano-usdm' || asset.name === 'base-usdc');
    logs.length = 0;

    await createReconciliationJob({
      db: database.db, config: { ...config, assets }, wallets: async () => treasuryWallets({ ...config, assets }), readerFor: readers(), ledger,
      metrics: createTreasuryMetrics(registry), clock, ids: randomIdGenerator, logger,
    })();

    const [run] = await database.db.select().from(reconciliationRuns);
    expect(run).toMatchObject({
      alerts: 1,
      results: {
        'cardano-usdm': { ledger: '40', chain: '40', drift: '0', alert: false },
        'base-usdc': { ledger: '10', chain: '12.5', drift: '2.5', alert: true },
      },
    });
    expect(logs).toContainEqual(expect.objectContaining({ asset: 'base-usdc', drift: '2.5', alert: true }));
    expect(await registry.metrics()).toMatch(/treasury_drift_usd\{asset="base-usdc"\} 2\.5/);
  });

  it('reports the Signer\'s hot wallets and warns below a day\'s limit, while reconciliation\'s totals stay unchanged (TR-1, TR-3, TR-5, T27)', async () => {
    const tempoAsset = config.assets.find(asset => asset.network.id === config.mpp.network.id)!;
    const wallets = { base: '0x3333333333333333333333333333333333333333', tempo: '0x4444444444444444444444444444444444444444' };
    const assets = config.assets.filter(asset => asset.name === 'cardano-usdm' || asset.name === 'base-usdc' || asset.name === tempoAsset.name);
    const withSigner = { ...config, assets, signer: { ...config.signer, wallets: { ...config.signer.wallets, ...wallets } } };
    // $4 on Base and $6 on Tempo, against a $5 daily limit
    evm.balances.set(wallets.base, 4_000_000n);
    evm.balances.set(wallets.tempo, 6_000_000n);
    const evmReaders = readerFor({
      cardano: createCardanoBalanceReader(createBlockfrostClient({ url: blockfrost.url, projectId: Secret.from('preprodTestProjectId'), timeoutMs: 2_000 })),
      evm: createEvmBalanceReader({ rpcUrlFor: network => network === 'eip155:84532' || network === config.mpp.network.id ? evm.url : undefined, timeoutMs: 2_000 }),
    });
    const registry = new Registry();
    logs.length = 0;

    await createTreasuryBalancesJob({
      wallets: async () => treasuryWallets(withSigner), readerFor: evmReaders, payouts: undefined, signerDailyLimit: 5_000_000n as MicroUsd,
      metrics: createTreasuryMetrics(registry), logger,
    })();

    const text = await registry.metrics();
    expect(text).toMatch(/treasury_balance_usd\{wallet="signer:base",asset="base-usdc"\} 4/);
    expect(text).toMatch(new RegExp(`treasury_balance_usd\\{wallet="signer:tempo",asset="${tempoAsset.name}"\\} 6`));
    const warnings = logs.filter(line => line['msg'] === 'A Signer wallet holds less than a day\'s spend limit: top it up');
    expect(warnings).toEqual([expect.objectContaining({ level: 40, wallet: 'signer:base', held: '4', dailyLimit: '5', alert: true })]);

    // TR-5: the operator funds hot wallets outside the ledger, so reconciliation leaves them out
    const ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
    const reconcileWith = async (source: PlatformConfig) => {
      await database.db.delete(reconciliationRuns);
      await createReconciliationJob({
        db: database.db, config: source, wallets: async () => treasuryWallets(source), readerFor: evmReaders, ledger,
        metrics: createTreasuryMetrics(new Registry()), clock, ids: randomIdGenerator, logger,
      })();
      const [run] = await database.db.select().from(reconciliationRuns);

      return run!.results;
    };
    expect(await reconcileWith(withSigner)).toEqual(await reconcileWith({ ...config, assets }));
  });
});

describe('the Solana balance reader and the treasury jobs on Solana (TR-1, TR-3, TR-5, P-6)', () => {
  // The fake answers on any path: production's NOWNodes URL carries its key there
  const rpcUrl = () => Secret.from(`${solana.url}/solana-rpc-key-secret`);
  const solanaReader = () => createSolanaBalanceReader({ rpcUrl: rpcUrl(), timeoutMs: 2_000 });
  const owner = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const usdc = () => findAsset(config, 'solana-usdc')!;

  it('reads the sum of the owner\'s token accounts for the mint, and 0 without one (TR-3)', async () => {
    solana.setTokenAccounts(owner, usdc().address, [3_000_000n, 1_250_000n]);
    const reader = solanaReader();

    expect(await reader.balance({ address: owner, asset: usdc() })).toBe(4_250_000n);
    expect(await reader.hasTokenAccount({ address: owner, asset: usdc() })).toBe(true);
    // Another mint's accounts don't count
    expect(await reader.balance({ address: owner, asset: { ...usdc(), address: 'So11111111111111111111111111111111111111112' } })).toBe(0n);

    solana.setTokenAccounts(owner, usdc().address, []);
    expect(await reader.balance({ address: owner, asset: usdc() })).toBe(0n);
    expect(await reader.hasTokenAccount({ address: owner, asset: usdc() })).toBe(false);
  });

  it.each([
    ['a JSON-RPC error', 'error', /refused getTokenAccountsByOwner/],
    ['an answer without accounts', 'malformed', /without a list of accounts/],
  ] as const)('throws on %s, without the RPC\'s URL (TR-3)', async (_case, mode, message) => {
    solana.failTokenAccounts(mode);
    try {
      const failure = await solanaReader().balance({ address: owner, asset: usdc() }).then(() => undefined, (error: unknown) => error as Error);

      expect(failure?.message).toMatch(message);
      expect(JSON.stringify({ message: failure?.message, cause: String(failure?.cause) })).not.toContain('solana-rpc-key-secret');
    }
    finally {
      solana.failTokenAccounts(undefined);
    }
  });

  it('throws when the RPC doesn\'t answer, without its URL (TR-3)', async () => {
    const failing = createSolanaBalanceReader({ rpcUrl: Secret.from('http://127.0.0.1:9/solana-rpc-key-secret'), timeoutMs: 2_000 });
    const failure = await failing.balance({ address: owner, asset: usdc() }).then(() => undefined, (error: unknown) => error as Error);

    expect(failure?.message).toBe('The Solana RPC didn\'t answer getTokenAccountsByOwner');
    expect(failure?.message).not.toContain('solana-rpc-key-secret');
  });

  it('reports the Solana treasury\'s balance, and warns once a run about a payTo without a USDC account (TR-1, TR-3)', async () => {
    const assets = config.assets.filter(asset => asset.name === 'solana-usdc');
    const wallets = async () => treasuryWallets({ ...config, assets });
    const solanaReaders = readerFor({ solana: solanaReader() });
    const run = async () => {
      const registry = new Registry();
      logs.length = 0;
      await createTreasuryBalancesJob({ wallets, readerFor: solanaReaders, payouts: undefined, signerDailyLimit: config.signer.maxPerNetworkPerDay, metrics: createTreasuryMetrics(registry), logger })();

      return { text: await registry.metrics(), warnings: logs.filter(line => line['msg'] === 'A payTo has no token account for its asset: payments to it fail until it has one') };
    };

    solana.setTokenAccounts(usdc().payTo, usdc().address, [7_500_000n]);
    const funded = await run();
    expect(funded.text).toMatch(/treasury_balance_usd\{wallet="payTo:solana-usdc",asset="solana-usdc"\} 7\.5/);
    expect(funded.warnings).toEqual([]);

    solana.setTokenAccounts(usdc().payTo, usdc().address, []);
    const missing = await run();
    expect(missing.text).toMatch(/treasury_balance_usd\{wallet="payTo:solana-usdc",asset="solana-usdc"\} 0/);
    expect(missing.warnings).toEqual([expect.objectContaining({
      level: 40, wallet: 'payTo:solana-usdc', asset: 'solana-usdc', network: usdc().network.id, address: usdc().payTo, alert: true,
    })]);

    // A USDC account that is merely empty is no warning
    solana.setTokenAccounts(usdc().payTo, usdc().address, [0n]);
    expect((await run()).warnings).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain('solana-rpc-key-secret');
  });

  it('reconciles solana-usdc: it matches when the ledger and the chain agree, and alerts above $1 of drift (TR-5)', async () => {
    const ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
    const assets = config.assets.filter(asset => asset.name === 'solana-usdc');
    const reconcileOnce = async () => {
      await database.db.delete(reconciliationRuns);
      const registry = new Registry();
      logs.length = 0;
      await createReconciliationJob({
        db: database.db, config: { ...config, assets }, wallets: async () => treasuryWallets({ ...config, assets }), readerFor: readerFor({ solana: solanaReader() }),
        ledger, metrics: createTreasuryMetrics(registry), clock, ids: randomIdGenerator, logger,
      })();
      const [run] = await database.db.select().from(reconciliationRuns);

      return { run: run!, text: await registry.metrics() };
    };
    // The ledger knows of 6 USDC on Solana
    await ledger.treasuryTransfer({ reference: 'seed-solana-usdc', from: { asset: 'seed', amount: 6_000_000n as MicroUsd }, to: { asset: 'solana-usdc', amount: 6_000_000n as MicroUsd } });

    solana.setTokenAccounts(usdc().payTo, usdc().address, [6_000_000n]);
    const agreed = await reconcileOnce();
    expect(agreed.run).toMatchObject({ alerts: 0, results: { 'solana-usdc': { ledger: '6', chain: '6', drift: '0', alert: false } } });

    solana.setTokenAccounts(usdc().payTo, usdc().address, [4_500_000n]);
    const drifted = await reconcileOnce();
    expect(drifted.run).toMatchObject({ alerts: 1, results: { 'solana-usdc': { ledger: '6', chain: '4.5', drift: '-1.5', alert: true } } });
    expect(logs).toContainEqual(expect.objectContaining({ asset: 'solana-usdc', drift: '-1.5', alert: true }));
    expect(drifted.text).toMatch(/treasury_drift_usd\{asset="solana-usdc"\} -1\.5/);
  });

  it('reports the Signer\'s Solana wallet and warns below a day\'s limit, while reconciliation\'s totals stay unchanged (TR-1, TR-3, TR-5, T29)', async () => {
    const signerWallet = 'HGvHArgEcqSUut2Cppn6fBQzLxtsaj8vBccTFyxFJzhC';
    const assets = config.assets.filter(asset => asset.name === 'solana-usdc');
    const withSigner = { ...config, assets, signer: { ...config.signer, wallets: { ...config.signer.wallets, solana: signerWallet } } };
    const solanaReaders = readerFor({ solana: solanaReader() });
    // $3 in the hot wallet, against a $5 daily limit; the treasury holds what the ledger says
    solana.setTokenAccounts(signerWallet, usdc().address, [3_000_000n]);
    solana.setTokenAccounts(usdc().payTo, usdc().address, [6_000_000n]);
    const registry = new Registry();
    logs.length = 0;

    await createTreasuryBalancesJob({
      wallets: async () => treasuryWallets(withSigner), readerFor: solanaReaders, payouts: undefined, signerDailyLimit: 5_000_000n as MicroUsd,
      metrics: createTreasuryMetrics(registry), logger,
    })();

    expect(await registry.metrics()).toMatch(/treasury_balance_usd\{wallet="signer:solana",asset="solana-usdc"\} 3/);
    expect(logs.filter(line => line['msg'] === 'A Signer wallet holds less than a day\'s spend limit: top it up')).toEqual([
      expect.objectContaining({ level: 40, wallet: 'signer:solana', held: '3', dailyLimit: '5', alert: true }),
    ]);

    const ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
    const reconcileWith = async (source: PlatformConfig) => {
      await database.db.delete(reconciliationRuns);
      await createReconciliationJob({
        db: database.db, config: source, wallets: async () => treasuryWallets(source), readerFor: solanaReaders, ledger, metrics: createTreasuryMetrics(new Registry()),
        clock, ids: randomIdGenerator, logger,
      })();
      const [run] = await database.db.select().from(reconciliationRuns);

      return run!.results;
    };
    expect(await reconcileWith(withSigner)).toEqual(await reconcileWith({ ...config, assets }));
  });
});
