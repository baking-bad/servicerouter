import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';

import type { Clock, IdGenerator, MicroUsd } from '@servicerouter/common';
import type { DepositAddressRecord, DepositRecord, DepositStore } from '@servicerouter/core';

import { createLedger } from './ledgerRepository.js';
import { withTransaction, type DatabaseExecutor } from './postgres.js';
import { depositAddresses, depositAddressIndex, deposits } from './schema/deposits.js';

export interface DepositRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The account's deposit address with its top-up token, as the API shows them. */
export interface DepositAddressView extends DepositAddressRecord {
  readonly network: string;
  // The chain's tip at the last scan. Undefined before the first.
  readonly tipHeight: number | undefined;
}

export interface DepositRepository extends DepositStore {
  findAddress(accountId: string): Promise<DepositAddressView | undefined>;
  findAddressByToken(token: string): Promise<DepositAddressView | undefined>;
  /**
   * The account's address, created at the next HD index the first time (DP-1). `derive` turns the index
   * into the address; `token` is the new top-up token. A concurrent call's address wins.
   */
  ensureAddress(input: {
    readonly accountId: string;
    readonly network: string;
    readonly derive: (index: number) => string;
    readonly token: () => string;
  }): Promise<DepositAddressView>;
  /** Moves the address's next scan to now, as when its top-up page is opened. */
  prioritize(address: string, now: Date): Promise<void>;
  /** The account's latest deposits, newest first (DP-5). */
  recent(accountId: string, limit: number): Promise<readonly DepositRecord[]>;
}

/** The ledger reference of a deposit's credit: once per transaction output (DP-3, LG-3). */
export const depositReference = (txHash: string, outputIndex: number): string => `deposit:${txHash}:${outputIndex}`;

const toAddress = (row: typeof depositAddresses.$inferSelect): DepositAddressView => ({
  accountId: row.accountId,
  address: row.address,
  derivationIndex: row.derivationIndex,
  topupToken: row.topupToken,
  scannedHeight: row.scannedHeight,
  network: row.network,
  tipHeight: row.tipHeight ?? undefined,
  createdAt: row.createdAt,
});

const toDeposit = (row: typeof deposits.$inferSelect): DepositRecord => ({
  txHash: row.txHash,
  outputIndex: row.outputIndex,
  accountId: row.accountId,
  address: row.address,
  quantity: row.quantity,
  usdAmount: (row.usdAmount ?? undefined) as MicroUsd | undefined,
  amounts: row.amounts,
  blockHeight: row.blockHeight,
  blockTime: row.blockTime,
  status: row.status,
  seenAt: row.seenAt,
  creditedAt: row.creditedAt ?? undefined,
});

const byOutput = (txHash: string, outputIndex: number) => and(eq(deposits.txHash, txHash), eq(deposits.outputIndex, outputIndex));

/** The `deposit_addresses` and `deposits` tables (Deposits). Credits go through the Ledger, once per output. */
export const createDepositRepository = ({ db, clock, ids }: DepositRepositoryOptions): DepositRepository => {
  const findAddress = async (accountId: string): Promise<DepositAddressView | undefined> => {
    const [row] = await db.select().from(depositAddresses).where(eq(depositAddresses.accountId, accountId));

    return row ? toAddress(row) : undefined;
  };

  return {
    findAddress,

    findAddressByToken: async token => {
      const [row] = await db.select().from(depositAddresses).where(eq(depositAddresses.topupToken, token));

      return row ? toAddress(row) : undefined;
    },

    ensureAddress: async ({ accountId, network, derive, token }) => {
      const existing = await findAddress(accountId);
      if (existing)
        return existing;

      const next = await db.execute<{ value: string }>(sql`select nextval(${`${depositAddressIndex.seqName}`}::regclass) as value`);
      const derivationIndex = Number(next.rows[0]!.value);
      const now = clock.now();
      await db.insert(depositAddresses)
        .values({ accountId, derivationIndex, address: derive(derivationIndex), network, topupToken: token(), nextCheckAt: now, createdAt: now })
        .onConflictDoNothing({ target: depositAddresses.accountId });

      return (await findAddress(accountId))!;
    },

    prioritize: async (address, now) => {
      await db.update(depositAddresses).set({ nextCheckAt: now })
        .where(and(eq(depositAddresses.address, address), sql`${depositAddresses.nextCheckAt} > ${now}`));
    },

    recent: async (accountId, limit) => (await db.select().from(deposits)
      .where(eq(deposits.accountId, accountId))
      .orderBy(desc(deposits.blockHeight), desc(deposits.outputIndex))
      .limit(limit)).map(toDeposit),

    dueAddresses: async ({ now, limit }) => (await db.select().from(depositAddresses)
      .where(lte(depositAddresses.nextCheckAt, now))
      .orderBy(asc(depositAddresses.nextCheckAt))
      .limit(limit)).map(toAddress),

    knownTransactions: async (address, txHashes) => {
      if (txHashes.length === 0)
        return new Set();

      const rows = await db.selectDistinct({ txHash: deposits.txHash }).from(deposits)
        .where(and(eq(deposits.address, address), inArray(deposits.txHash, [...txHashes])));

      return new Set(rows.map(row => row.txHash));
    },

    recordDeposits: async items => {
      if (items.length === 0)
        return;

      await db.insert(deposits).values(items.map(item => ({
        txHash: item.txHash,
        outputIndex: item.outputIndex,
        accountId: item.accountId,
        address: item.address,
        quantity: item.quantity,
        usdAmount: item.usdAmount ?? null,
        amounts: { ...item.amounts },
        blockHeight: item.blockHeight,
        blockTime: item.blockTime,
        status: item.status,
        seenAt: item.seenAt,
      }))).onConflictDoNothing();
    },

    pendingDeposits: async address => (await db.select().from(deposits)
      .where(and(eq(deposits.address, address), eq(deposits.status, 'pending')))
      .orderBy(asc(deposits.blockHeight), asc(deposits.outputIndex))).map(toDeposit),

    credit: ({ txHash, outputIndex, now }) => withTransaction(db, async tx => {
      const [row] = await tx.select().from(deposits).where(byOutput(txHash, outputIndex)).for('update');
      if (!row || row.status !== 'pending' || !row.usdAmount || row.usdAmount <= 0n)
        return false;

      // Deposits clearing → buyer available, idempotent by the output's reference (DP-3, LG-3)
      const credited = await createLedger({ db: tx, clock, ids }).credit({
        accountId: row.accountId, amount: row.usdAmount as MicroUsd, reference: depositReference(txHash, outputIndex),
      });
      await tx.update(deposits).set({ status: 'credited', ledgerTransactionId: credited.transactionId, creditedAt: now }).where(byOutput(txHash, outputIndex));

      return !credited.replayed;
    }),

    drop: async ({ txHash, outputIndex }) => {
      await db.update(deposits).set({ status: 'dropped' }).where(and(byOutput(txHash, outputIndex), eq(deposits.status, 'pending')));
    },

    moveBlock: async ({ txHash, blockHeight }) => {
      await db.update(deposits).set({ blockHeight }).where(and(eq(deposits.txHash, txHash), eq(deposits.status, 'pending')));
    },

    markScanned: async ({ address, scannedHeight, tipHeight, nextCheckAt }) => {
      await db.update(depositAddresses).set({ scannedHeight, tipHeight, nextCheckAt }).where(eq(depositAddresses.address, address));
    },
  };
};
