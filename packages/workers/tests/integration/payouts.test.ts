import { fixtureRun, fixtureTime } from '@servicerouter/testing';

import * as Address from '@evolution-sdk/evolution/Address';
import * as PrivateKey from '@evolution-sdk/evolution/PrivateKey';
import * as Transaction from '@evolution-sdk/evolution/Transaction';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret, type MicroUsd, type ServiceId } from '@servicerouter/common';
import {
  blockfrostUnit, createBlockfrostClient, findAsset, hashApiKey, loadPlatformConfig, type Asset, type NewPayment, type PlatformConfig,
  type ServiceConfigDocument,
} from '@servicerouter/core';
import {
  createAccountRepository, createLedger, createPaymentKeyRepository, createPaymentRepository, createPayoutRepository, createServiceRepository,
  ledgerAccountIds, payouts, payoutRuns, type Ledger,
} from '@servicerouter/db';
import { createFakeClock, createTestDatabase, startFakeBlockfrost, type FakeBlockfrost, type FakeClock, type TestDatabase } from '@servicerouter/testing';

import { createPayoutsJob, payoutConfirmations } from '../../src/payouts/job.js';
import { createCardanoPayoutWallet, type PayoutWallet } from '../../src/payouts/wallet.js';

// Valid preprod addresses that sellers are paid at
const sellerAddresses = [
  'addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5',
  'addr_test1vqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygxrcya6',
  'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz',
];
const logger = createLogger({ level: 'silent' });

let database: TestDatabase;
let blockfrost: FakeBlockfrost;
let config: PlatformConfig;
let clock: FakeClock;
let ledger: Ledger;
let usdm: Asset;
let wallet: PayoutWallet;
let counter = 0;

beforeAll(async () => {
  [database, blockfrost, config] = await Promise.all([createTestDatabase(), startFakeBlockfrost(), loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } })]);
  clock = createFakeClock(fixtureTime(0, 10, 12, 0, 0, 0));
  ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
  usdm = findAsset(config, 'cardano-usdm')!;
  wallet = createCardanoPayoutWallet({
    mnemonic: Secret.from(PrivateKey.generateMnemonic(256)),
    asset: usdm,
    blockfrost: { url: blockfrost.url, projectId: Secret.from('preprodTestProjectId') },
  });
  // ADA for fees and each output's minimum, and USDM to pay out
  blockfrost.fund(wallet.address, { lovelace: 100_000_000n, assets: { [usdm.address]: 1_000_000_000n } });
});

afterAll(async () => {
  await blockfrost?.close();
  await database?.drop();
});

const job = ({ needsApproval = false, payoutWallet = wallet } = {}) => createPayoutsJob({
  repository: createPayoutRepository({ db: database.db, clock, ids: randomIdGenerator }),
  wallet: payoutWallet,
  blockfrost: createBlockfrostClient({ url: blockfrost.url, projectId: Secret.from('preprodTestProjectId'), timeoutMs: 5_000 }),
  clock,
  ids: randomIdGenerator,
  logger,
  asset: usdm,
  minimum: config.payouts.minimum,
  needsApproval,
});

const newAccount = async (): Promise<string> => {
  counter += 1;
  const id = `acc_${counter}`;
  await createAccountRepository({ db: database.db }).create({ id, email: undefined, createdAt: clock.now() });

  return id;
};

/** A seller with a live service paid at this address. */
const seller = async (address: string) => {
  const accountId = await newAccount();
  counter += 1;
  const serviceId = `svc-${counter}` as ServiceId;
  const repository = createServiceRepository({ db: database.db });
  const serviceConfig = { payouts: { default: { asset: 'cardano-usdm', address } }, upstreams: [] } as unknown as ServiceConfigDocument;
  await repository.createIfMissing({ id: serviceId, ownerAccountId: accountId, state: 'live', createdAt: clock.now() });
  await repository.insertRevision({ serviceId, number: 1, submitted: { mediaType: 'application/yaml', text: '' }, config: serviceConfig, openapiDocuments: new Map(), createdBy: accountId, createdAt: clock.now() });
  await repository.activate({ id: serviceId, revision: 1, hosts: [], state: 'live', updatedAt: clock.now() });

  return { accountId, serviceId };
};

/** A buyer pays the seller's service this much with credits, captured with a 2.5% fee. */
const earn = async ({ accountId, serviceId }: { accountId: string; serviceId: string }, amount: bigint): Promise<void> => {
  const buyer = await newAccount();
  counter += 1;
  const keyId = `key_${counter}`;
  await createPaymentKeyRepository({ db: database.db }).insert({
    id: keyId, accountId: buyer, keyHash: hashApiKey(Secret.from(`sr_test_${keyId}`)), label: undefined, createdAt: clock.now(),
    allowance: undefined, dailyBudget: 1_000_000_000n, maxPrice: undefined, expiresAt: undefined,
  });
  await ledger.credit({ accountId: buyer, amount: amount as MicroUsd, reference: `credit-${buyer}` });
  const held = await ledger.hold({
    payment: {
      id: `pay_${counter}`, requestId: undefined, kind: 'service', rail: 'credits', buyerAccountId: buyer, keyId, sellerAccountId: accountId, serviceId,
      routeKey: 'op', targetHost: undefined, targetPath: undefined, network: undefined, asset: undefined, atomicAmount: undefined, amount,
    } as NewPayment & { rail: 'credits'; buyerAccountId: string; keyId: string },
    dailyBudget: 1_000_000_000n,
    allowance: undefined,
  });
  if (!held.ok)
    throw new Error(held.refusal);
  await createPaymentRepository({ db: database.db, clock }).recordDecision({ paymentId: held.payment.id, decision: 'billable', upstreamStatus: 200, upstreamLatencyMs: 1 });
  await ledger.capture({ paymentId: held.payment.id, feeBps: 250 });
};

const earned = async (accountId: string): Promise<bigint> => (await ledger.balancesOf([ledgerAccountIds.earned(accountId)])).get(ledgerAccountIds.earned(accountId)) ?? 0n;
const runOf = async (id: string) => (await database.db.select().from(payoutRuns).where(eq(payoutRuns.id, id)))[0];
const payoutsOf = (runId: string) => database.db.select().from(payouts).where(eq(payouts.runId, runId));

/** What a signed transaction pays each address, in USDM's atomic units. */
const paidBy = (cbor: string): Record<string, bigint> => {
  const transaction = Transaction.fromCBORHex(cbor);
  const unit = blockfrostUnit(usdm);
  const result: Record<string, bigint> = {};
  for (const output of transaction.body.outputs) {
    const address = Address.toBech32(output.address);
    const assets = output.assets as unknown as { multiAsset?: { map: Map<{ toString(): string }, Map<{ bytes: Uint8Array }, bigint>> } };
    for (const [policy, names] of assets.multiAsset?.map ?? []) {
      for (const [name, quantity] of names) {
        if (`${policy.toString()}${Buffer.from(name.bytes).toString('hex')}` === unit)
          result[address] = (result[address] ?? 0n) + quantity;
      }
    }
  }

  return result;
};

describe('payouts (PO-1 to PO-7)', () => {
  it('pays each seller its net earnings once, in one batched USDM transaction, and books it once confirmed', async () => {
    const [first, second, small] = [await seller(sellerAddresses[0]!), await seller(sellerAddresses[1]!), await seller(sellerAddresses[2]!)];
    await earn(first, 20_000_000n);
    await earn(first, 4_000_000n);
    await earn(second, 12_000_000n);
    // Below the $10 minimum after the fee: rolls over
    await earn(small, 5_000_000n);

    clock.set(new Date(fixtureTime(1, 1, 0, 5, 0, 0)));
    const result = await job()();
    const run = await runOf(fixtureRun(1, 1));
    const transactions = await createPayoutRepository({ db: database.db, clock, ids: randomIdGenerator }).transactions(fixtureRun(1, 1));

    expect(result.built).toBe(fixtureRun(1, 1));
    expect(run).toMatchObject({ status: 'submitted', total: 35_100_000n });
    expect(transactions).toHaveLength(1);
    expect(blockfrost.submitted.get(transactions[0]!.txHash)).toBe(transactions[0]!.cbor);
    // 24 and 12 USD, less 2.5%: USDM has 6 decimals, so atomic units equal micro-USD
    expect(paidBy(transactions[0]!.cbor)).toMatchObject({ [sellerAddresses[0]!]: 23_400_000n, [sellerAddresses[1]!]: 11_700_000n });
    expect(paidBy(transactions[0]!.cbor)[sellerAddresses[2]!]).toBeUndefined();
    // Not booked before its confirmations
    expect(await earned(first.accountId)).toBe(23_400_000n);

    blockfrost.addBlocks(payoutConfirmations - 1);
    clock.advance(10 * 60_000);
    const followed = await job()();

    expect(followed.confirmed).toBe(1);
    expect(await runOf(fixtureRun(1, 1))).toMatchObject({ status: 'confirmed' });
    expect((await payoutsOf(fixtureRun(1, 1))).map(payout => payout.status)).toEqual(['confirmed', 'confirmed']);
    expect(await earned(first.accountId)).toBe(0n);
    expect(await earned(second.accountId)).toBe(0n);
    expect(await earned(small.accountId)).toBe(4_875_000n);
    const treasury = await ledger.balancesOf([ledgerAccountIds.treasury('cardano-usdm')]);
    expect(treasury.get(ledgerAccountIds.treasury('cardano-usdm'))).toBe(35_100_000n);

    // A second run in the same month moves nothing (PO-4)
    const submittedBefore = blockfrost.submitted.size;
    clock.advance(10 * 60_000);
    await job()();
    expect(blockfrost.submitted.size).toBe(submittedBefore);
    expect(await earned(small.accountId)).toBe(4_875_000n);

    // Next month, the small seller's earnings reach the minimum and are paid; the others owe nothing
    await earn(small, 6_000_000n);
    clock.set(new Date(fixtureTime(2, 1, 0, 5, 0, 0)));
    await job()();
    const december = await payoutsOf(fixtureRun(2, 1));
    expect(december.map(payout => [payout.address, payout.amount])).toEqual([[sellerAddresses[2]!, 10_725_000n]]);
  });

  it('waits for an operator on mainnet: nothing is submitted until the run is approved (PO-6)', async () => {
    const paid = await seller(sellerAddresses[0]!);
    await earn(paid, 15_000_000n);
    clock.set(new Date(fixtureTime(3, 1, 0, 5, 0, 0)));
    const repository = createPayoutRepository({ db: database.db, clock, ids: randomIdGenerator });
    const submittedBefore = blockfrost.submitted.size;

    await job({ needsApproval: true })();
    clock.advance(10 * 60_000);
    await job({ needsApproval: true })();

    expect(await runOf(fixtureRun(3, 1))).toMatchObject({ status: 'awaiting_approval' });
    expect(blockfrost.submitted.size).toBe(submittedBefore);

    expect(await repository.approve({ id: fixtureRun(3, 1), by: 'operator' })).toMatchObject({ status: 'approved', approvedBy: 'operator' });
    expect(await repository.approve({ id: fixtureRun(3, 1), by: 'operator' })).toBeUndefined();
    clock.advance(10 * 60_000);
    const result = await job({ needsApproval: true })();

    expect(result.submitted).toBe(1);
    expect(blockfrost.submitted.size).toBe(submittedBefore + 1);
  });

  it('stops and alerts when the wallet doesn\'t cover the run, and builds it once the wallet is funded (PO-5)', async () => {
    const poor = createCardanoPayoutWallet({
      mnemonic: Secret.from(PrivateKey.generateMnemonic(256)), asset: usdm, blockfrost: { url: blockfrost.url, projectId: Secret.from('preprodTestProjectId') },
    });
    blockfrost.fund(poor.address, { lovelace: 100_000_000n, assets: { [usdm.address]: 1_000_000n } });
    const paid = await seller(sellerAddresses[1]!);
    await earn(paid, 50_000_000n);
    clock.set(new Date(fixtureTime(4, 1, 0, 5, 0, 0)));

    await job({ payoutWallet: poor })();
    const stopped = await runOf(fixtureRun(4, 1));

    expect(stopped).toMatchObject({ status: 'stopped', problem: expect.stringContaining('payout wallet holds 1000000') });
    blockfrost.fund(poor.address, { lovelace: 0n, assets: { [usdm.address]: 100_000_000n } });
    clock.advance(10 * 60_000);
    await job({ payoutWallet: poor })();
    expect((await runOf(fixtureRun(4, 1)))?.status).toBe('submitted');
  });

  it('leaves a refused transaction\'s earnings for the next run (PO-7)', async () => {
    const paid = await seller(sellerAddresses[2]!);
    await earn(paid, 30_000_000n);
    clock.set(new Date(fixtureTime(5, 1, 0, 5, 0, 0)));
    blockfrost.onSubmit('reject');
    try {
      await job()();
    }
    finally {
      blockfrost.onSubmit('include');
    }

    expect((await payoutsOf(fixtureRun(5, 1))).map(payout => payout.status)).toEqual(['failed']);
    expect(await earned(paid.accountId)).toBe(29_250_000n);
    clock.advance(10 * 60_000);
    await job()();
    expect((await runOf(fixtureRun(5, 1)))?.status).toBe('failed');

    clock.set(new Date(fixtureTime(6, 1, 0, 5, 0, 0)));
    await job()();
    expect((await payoutsOf(fixtureRun(6, 1))).map(payout => [payout.address, payout.amount])).toEqual([[sellerAddresses[2]!, 29_250_000n]]);
  });
});
