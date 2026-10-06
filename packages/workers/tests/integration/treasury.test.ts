import { fixtureTime } from '@servicerouter/testing';

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Registry } from '@prometheus-io/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret, type MicroUsd } from '@servicerouter/common';
import { createBlockfrostClient, findAsset, loadPlatformConfig, treasuryWallets, type PlatformConfig } from '@servicerouter/core';
import { createLedger, reconciliationRuns } from '@servicerouter/db';
import { createFakeClock, createTestDatabase, startFakeBlockfrost, type FakeBlockfrost, type TestDatabase } from '@servicerouter/testing';

import { createReconciliationJob, createTreasuryBalancesJob, createTreasuryMetrics } from '../../src/treasury/jobs.js';
import { createCardanoBalanceReader, createEvmBalanceReader, readerFor } from '../../src/treasury/readers.js';

const clock = createFakeClock(fixtureTime(1, 2, 0, 0, 0, 0));
const logs: Record<string, unknown>[] = [];
const logger = createLogger({}, { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) });

let database: TestDatabase;
let blockfrost: FakeBlockfrost;
let config: PlatformConfig;
let evm: { url: string; close(): Promise<void>; balances: Map<string, bigint> };

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
  [database, blockfrost, config, evm] = await Promise.all([
    createTestDatabase(), startFakeBlockfrost(), loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } }), startFakeEvmRpc(),
  ]);
});

afterAll(async () => {
  await Promise.all([blockfrost?.close(), evm?.close()]);
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

    await createTreasuryBalancesJob({ wallets, readerFor: readers(), payouts: undefined, metrics, logger })();

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
});
