import type { Clock, Logger } from '@servicerouter/common';
import { createDepositWatcher, type BlockfrostClient, type DepositStore, type DepositWatchResult, type PlatformConfig } from '@servicerouter/core';

// WK-1: one runner across replicas
export const depositWatcherLockId = 7_301_746_204;
// DP-2: every few seconds. Each run scans the addresses that are due, a batch at a time.
export const depositWatcherIntervalMs = 20_000;
export const depositWatcherBatchSize = 10;
export const depositWatcherJobName = 'deposit_watcher';

/** Some addresses couldn't be scanned. They are due again, and the job stays stale (WK-4). */
export class DepositWatcherFailedError extends Error {
  constructor(readonly result: DepositWatchResult) {
    super(`${result.failed} deposit addresses couldn't be scanned`);
  }
}

/** The deposit watcher (DP-2, DP-3): scans due addresses through Blockfrost and credits confirmed deposits once. */
export const createDepositWatcherJob = ({ store, blockfrost, clock, logger, deposits, batchSize = depositWatcherBatchSize }: {
  readonly store: DepositStore;
  readonly blockfrost: BlockfrostClient;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly deposits: NonNullable<PlatformConfig['deposits']>;
  readonly batchSize?: number;
}) => {
  const watch = createDepositWatcher({ store, blockfrost, clock, logger, asset: deposits.asset, confirmations: deposits.confirmations });

  return async (): Promise<DepositWatchResult> => {
    const result = await watch({ limit: batchSize });
    if (result.failed > 0)
      throw new DepositWatcherFailedError(result);

    return result;
  };
};
