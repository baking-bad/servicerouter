import { fixtureTime } from '@servicerouter/testing';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret } from '@servicerouter/common';
import { createBlockfrostClient, createDepositAddressDeriver, loadPlatformConfig, type PlatformConfig } from '@servicerouter/core';
import { createAccountRepository, createDepositRepository, createLedger, deposits, depositAddresses, type DepositRepository } from '@servicerouter/db';
import {
  createFakeClock, createTestDatabase, createTestDepositWallet, startFakeBlockfrost, type FakeBlockfrost, type FakeClock, type TestDatabase,
} from '@servicerouter/testing';

import { createDepositWatcherJob, DepositWatcherFailedError } from '../../src/depositWatcher.js';

let database: TestDatabase;
let clock: FakeClock;
let blockfrost: FakeBlockfrost;
let config: PlatformConfig;
let repository: DepositRepository;
let derive: (index: number) => string;
let counter = 0;

beforeAll(async () => {
  [database, blockfrost, config] = await Promise.all([
    createTestDatabase(), startFakeBlockfrost(), loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } }),
  ]);
  clock = createFakeClock(fixtureTime(-4, 1, 0, 0, 0, 0));
  repository = createDepositRepository({ db: database.db, clock, ids: randomIdGenerator });
  derive = createDepositAddressDeriver({ accountPublicKey: createTestDepositWallet().accountPublicKey, network: config.deposits!.network });
});

afterAll(async () => {
  await blockfrost?.close();
  await database?.drop();
});

const usdm = (): string => config.deposits!.asset.address;

const watcher = (logger = createLogger({ level: 'silent' })) => createDepositWatcherJob({
  store: repository,
  blockfrost: createBlockfrostClient({ url: blockfrost.url, projectId: Secret.from('preprodTestProjectId'), timeoutMs: 2_000 }),
  clock,
  logger,
  deposits: config.deposits!,
});

/** An account with its deposit address, due for a scan now. */
const buyer = async () => {
  counter += 1;
  const accountId = `acc_${counter}`;
  await createAccountRepository({ db: database.db }).create({ id: accountId, email: undefined, createdAt: clock.now() });
  const address = await repository.ensureAddress({ accountId, network: config.deposits!.network.id, derive, token: () => `token-${counter}-${'x'.repeat(24)}` });

  return { accountId, address: address.address };
};

const available = async (accountId: string): Promise<bigint> => (await createLedger({ db: database.db, clock, ids: randomIdGenerator }).balance(accountId)).available;
const depositRows = (address: string) => database.db.select().from(deposits).where(eq(deposits.address, address));
// Every address is due again: the test moves past the watcher's re-check time
const later = (): void => clock.advance(15 * 60_000);

describe('the deposit watcher (DP-2, DP-3, DP-4)', () => {
  it('credits a USDM deposit once, only after the confirmation threshold', async () => {
    const { accountId, address } = await buyer();
    const txHash = blockfrost.send([{ address, value: { lovelace: 1_500_000n, assets: { [usdm()]: 25_000_000n } } }]);

    const seen = await watcher()();

    expect(seen).toMatchObject({ recorded: 1, credited: 0 });
    expect(await depositRows(address)).toMatchObject([{ txHash, outputIndex: 0, quantity: 25_000_000n, usdAmount: 25_000_000n, status: 'pending' }]);
    expect(await available(accountId)).toBe(0n);

    // 14 blocks on top of its own: 15 confirmations, the threshold
    blockfrost.addBlocks(config.deposits!.confirmations - 2);
    later();
    expect((await watcher()()).credited).toBe(0);
    blockfrost.addBlocks(1);
    later();
    const credited = await watcher()();

    expect(credited.credited).toBe(1);
    expect(await available(accountId)).toBe(25_000_000n);
    expect(await depositRows(address)).toMatchObject([{ status: 'credited', ledgerTransactionId: expect.any(String) }]);

    // Running again moves nothing
    later();
    await watcher()();
    await watcher()();
    expect(await available(accountId)).toBe(25_000_000n);
  });

  it('records ADA and other assets without crediting them (DP-4)', async () => {
    const { accountId, address } = await buyer();
    blockfrost.send([{ address, value: { lovelace: 10_000_000n } }]);
    blockfrost.send([{ address, value: { lovelace: 1_500_000n, assets: { ['a'.repeat(56) + '.' + '4f54484552']: 5_000_000n } } }]);
    blockfrost.addBlocks(30);

    await watcher()();

    expect((await depositRows(address)).map(row => [row.status, row.usdAmount])).toEqual([['not_credited', null], ['not_credited', null]]);
    expect(await available(accountId)).toBe(0n);
  });

  it('never credits a deposit whose transaction a re-org dropped before the threshold (DP-3)', async () => {
    const { accountId, address } = await buyer();
    const txHash = blockfrost.send([{ address, value: { lovelace: 1_500_000n, assets: { [usdm()]: 7_000_000n } } }]);
    await watcher()();

    blockfrost.dropTransaction(txHash);
    blockfrost.addBlocks(40);
    later();
    await watcher()();

    expect(await depositRows(address)).toMatchObject([{ status: 'dropped' }]);
    expect(await available(accountId)).toBe(0n);
  });

  it('credits only the outputs to the address, each once, from a transaction that pays several', async () => {
    const [first, second] = [await buyer(), await buyer()];
    blockfrost.send([
      { address: first.address, value: { lovelace: 1_500_000n, assets: { [usdm()]: 1_000_000n } } },
      { address: second.address, value: { lovelace: 1_500_000n, assets: { [usdm()]: 2_000_000n } } },
      { address: first.address, value: { lovelace: 1_500_000n, assets: { [usdm()]: 3_000_000n } } },
    ]);
    blockfrost.addBlocks(30);

    await Promise.all([watcher()(), watcher()()]);
    later();
    await watcher()();

    expect(await available(first.accountId)).toBe(4_000_000n);
    expect(await available(second.accountId)).toBe(2_000_000n);
  });

  it('fails the run when Blockfrost fails an address, so the job goes stale, and scans it again next time', async () => {
    const { address } = await buyer();
    const broken = createDepositWatcherJob({
      store: repository,
      blockfrost: {
        latestBlockHeight: async () => blockfrost.tipHeight,
        addressTransactions: async () => {
          throw new Error('Blockfrost is down');
        },
        transactionOutputs: async () => undefined,
        transactionHeight: async () => undefined,
        addressAmounts: async () => new Map(),
        submitTransaction: async () => {
          throw new Error('Not used');
        },
      },
      clock,
      logger: createLogger({ level: 'silent' }),
      deposits: config.deposits!,
    });

    await expect(broken()).rejects.toBeInstanceOf(DepositWatcherFailedError);
    const [row] = await database.db.select().from(depositAddresses).where(eq(depositAddresses.address, address));
    expect(row!.nextCheckAt.getTime()).toBeLessThanOrEqual(clock.now().getTime());
  });
});

describe('the deposit watcher\'s lines (L-8)', () => {
  it('logs each deposit it sees and credits, with the account, the transaction, and the amount', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const { accountId, address } = await buyer();
    const txHash = blockfrost.send([{ address, value: { lovelace: 1_500_000n, assets: { [usdm()]: 7_000_000n } } }]);
    await watcher(logger)();
    blockfrost.addBlocks(config.deposits!.confirmations);
    later();

    await watcher(logger)();

    expect(lines.find(line => line['msg'] === 'A deposit was seen' && line['txHash'] === txHash)).toMatchObject({ level: 30, accountId, outputIndex: 0, status: 'pending' });
    expect(lines.find(line => line['msg'] === 'A deposit was credited' && line['txHash'] === txHash)).toMatchObject({ level: 30, accountId, outputIndex: 0, amount: '7000000' });
    expect(JSON.stringify(lines)).not.toContain('preprodTestProjectId');
  });
});
