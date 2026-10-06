import type { Clock, Logger, MicroUsd } from '@servicerouter/common';

import type { Asset } from '../platform/config.js';
import type { BlockfrostClient } from './blockfrost.js';

/** A deposit's state (DP-3, DP-4). */
export const depositStatuses = ['pending', 'credited', 'not_credited', 'dropped'] as const;
export type DepositStatus = typeof depositStatuses[number];

export interface DepositAddressRecord {
  readonly accountId: string;
  readonly address: string;
  readonly derivationIndex: number;
  // AK-15: its own random token, for the top-up link
  readonly topupToken: string;
  // The block height the next scan starts from
  readonly scannedHeight: number;
  readonly createdAt: Date;
}

export interface DepositRecord {
  readonly txHash: string;
  readonly outputIndex: number;
  readonly accountId: string;
  readonly address: string;
  // Of the deposit asset, in its atomic units. 0 when the output holds none.
  readonly quantity: bigint;
  // What it credits (DP-4). Undefined for an output without the deposit asset.
  readonly usdAmount: MicroUsd | undefined;
  // Every amount of the output, by Blockfrost unit
  readonly amounts: Readonly<Record<string, string>>;
  readonly blockHeight: number;
  readonly blockTime: Date;
  readonly status: DepositStatus;
  readonly seenAt: Date;
  readonly creditedAt: Date | undefined;
}

export type NewDeposit = Omit<DepositRecord, 'status' | 'creditedAt'> & { readonly status: 'pending' | 'not_credited' };

/** Port: the `deposit_addresses` and `deposits` tables (Deposits). */
export interface DepositStore {
  /** Addresses due for a scan, the longest-waiting first. */
  dueAddresses(input: { readonly now: Date; readonly limit: number }): Promise<readonly DepositAddressRecord[]>;
  /** Transactions of the address already recorded, among these. */
  knownTransactions(address: string, txHashes: readonly string[]): Promise<ReadonlySet<string>>;
  /** Records outputs to an address, once each by transaction and output (DP-3). */
  recordDeposits(deposits: readonly NewDeposit[]): Promise<void>;
  /** The address's deposits not credited yet. */
  pendingDeposits(address: string): Promise<readonly DepositRecord[]>;
  /** Credits a pending deposit: deposits clearing → buyer available, once (DP-3). Returns whether this call did. */
  credit(input: { readonly txHash: string; readonly outputIndex: number; readonly now: Date }): Promise<boolean>;
  /** The chain no longer has the transaction: nothing is credited. */
  drop(input: { readonly txHash: string; readonly outputIndex: number; readonly now: Date }): Promise<void>;
  /** A re-org moved the transaction to another block. */
  moveBlock(input: { readonly txHash: string; readonly blockHeight: number }): Promise<void>;
  /** Records a scan: where the next one starts, the chain's tip, and when it is due. */
  markScanned(input: { readonly address: string; readonly scannedHeight: number; readonly tipHeight: number; readonly nextCheckAt: Date }): Promise<void>;
}

// A scanned address with deposits on their way is scanned again soon; an idle one less often
export const depositRecheckPendingMs = 60_000;
export const depositRecheckIdleMs = 10 * 60_000;

export interface DepositWatcherOptions {
  readonly store: DepositStore;
  readonly blockfrost: BlockfrostClient;
  readonly clock: Clock;
  readonly logger: Logger;
  // The deposit asset (DP-4) and the blocks a deposit waits for (DP-3)
  readonly asset: Asset;
  readonly confirmations: number;
}

export interface DepositWatchResult {
  readonly addresses: number;
  readonly recorded: number;
  readonly credited: number;
  readonly dropped: number;
  readonly failed: number;
}

/** Blockfrost's unit for a Cardano asset of the registry: its policy ID and asset name hex, joined. */
export const blockfrostUnit = (asset: Pick<Asset, 'address'>): string => asset.address.replace('.', '').toLowerCase();

/** A pegged asset's atomic amount in micro-USD, rounded down (DP-4). */
export const depositUsdAmount = (quantity: bigint, decimals: number): MicroUsd =>
  (decimals >= 6 ? quantity / 10n ** BigInt(decimals - 6) : quantity * 10n ** BigInt(6 - decimals)) as MicroUsd;

/**
 * The deposit watcher (DP-2 to DP-4): scans the due addresses through Blockfrost, records each output
 * to them once, and credits the deposit asset 1:1 in USD once its transaction has the confirmations.
 * Other assets, ADA included, are recorded and never credited. Before a credit, the transaction is
 * read again, so one a re-org dropped is never credited.
 */
export const createDepositWatcher = ({ store, blockfrost, clock, logger, asset, confirmations }: DepositWatcherOptions) => {
  const unit = blockfrostUnit(asset);

  const scan = async (address: DepositAddressRecord, latest: number): Promise<{ recorded: number; credited: number; dropped: number }> => {
    const transactions = await blockfrost.addressTransactions(address.address, address.scannedHeight);
    const known = await store.knownTransactions(address.address, transactions.map(transaction => transaction.txHash));
    const seenAt = clock.now();
    const deposits: NewDeposit[] = [];
    for (const transaction of transactions.filter(item => !known.has(item.txHash))) {
      const outputs = await blockfrost.transactionOutputs(transaction.txHash);
      for (const output of outputs?.filter(item => item.address === address.address) ?? []) {
        const quantity = output.amounts.find(amount => amount.unit === unit)?.quantity ?? 0n;
        deposits.push({
          txHash: transaction.txHash,
          outputIndex: output.outputIndex,
          accountId: address.accountId,
          address: address.address,
          quantity,
          usdAmount: quantity > 0n ? depositUsdAmount(quantity, asset.decimals) : undefined,
          amounts: Object.fromEntries(output.amounts.map(amount => [amount.unit, amount.quantity.toString()])),
          blockHeight: transaction.blockHeight,
          blockTime: transaction.blockTime,
          // DP-4: only the deposit asset is credited
          status: quantity > 0n ? 'pending' : 'not_credited',
          seenAt,
        });
      }
    }
    await store.recordDeposits(deposits);
    for (const deposit of deposits)
      logger.info({ accountId: deposit.accountId, txHash: deposit.txHash, outputIndex: deposit.outputIndex, status: deposit.status }, 'A deposit was seen');

    let credited = 0;
    let dropped = 0;
    let waiting = 0;
    for (const deposit of await store.pendingDeposits(address.address)) {
      if (latest - deposit.blockHeight + 1 < confirmations) {
        waiting += 1;
        continue;
      }
      // Read again: a re-org may have dropped or moved the transaction
      const height = await blockfrost.transactionHeight(deposit.txHash);
      const now = clock.now();
      if (height === undefined) {
        await store.drop({ txHash: deposit.txHash, outputIndex: deposit.outputIndex, now });
        logger.warn({ accountId: deposit.accountId, txHash: deposit.txHash }, 'A deposit\'s transaction is no longer on the chain: nothing was credited');
        dropped += 1;
      }
      else if (height !== deposit.blockHeight) {
        await store.moveBlock({ txHash: deposit.txHash, blockHeight: height });
        waiting += 1;
      }
      else if (await store.credit({ txHash: deposit.txHash, outputIndex: deposit.outputIndex, now })) {
        logger.info({ accountId: deposit.accountId, txHash: deposit.txHash, outputIndex: deposit.outputIndex, amount: deposit.usdAmount?.toString() }, 'A deposit was credited');
        credited += 1;
      }
    }

    const lastHeight = transactions.at(-1)?.blockHeight ?? address.scannedHeight;
    await store.markScanned({
      address: address.address,
      scannedHeight: lastHeight,
      tipHeight: latest,
      nextCheckAt: new Date(clock.now().getTime() + (waiting > 0 ? depositRecheckPendingMs : depositRecheckIdleMs)),
    });

    return { recorded: deposits.length, credited, dropped };
  };

  return async ({ limit }: { readonly limit: number }): Promise<DepositWatchResult> => {
    const addresses = await store.dueAddresses({ now: clock.now(), limit });
    if (addresses.length === 0)
      return { addresses: 0, recorded: 0, credited: 0, dropped: 0, failed: 0 };

    const latest = await blockfrost.latestBlockHeight();
    const result = { addresses: addresses.length, recorded: 0, credited: 0, dropped: 0, failed: 0 };
    // One address at a time, to stay within Blockfrost's rate limit
    for (const address of addresses) {
      try {
        const scanned = await scan(address, latest);
        result.recorded += scanned.recorded;
        result.credited += scanned.credited;
        result.dropped += scanned.dropped;
      }
      catch (error) {
        result.failed += 1;
        logger.error({ error, accountId: address.accountId }, 'Failed to scan a deposit address');
      }
    }

    return result;
  };
};
