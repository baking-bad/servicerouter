import type { Clock, IdGenerator, Logger, MicroUsd } from '@servicerouter/common';
import {
  batchPayouts, blockfrostUnit, payoutCutoff, payoutRunId, payoutValidityMs, planPayouts, TransactionRejectedError, usdToAtomic,
  type Asset, type BlockfrostClient,
} from '@servicerouter/core';
import type { PayoutRepository } from '@servicerouter/db';

import { PayoutBuildError, type PayoutWallet } from './wallet.js';

// WK-1: one runner across replicas
export const payoutsLockId = 7_301_746_205;
// The job checks every 10 minutes: it builds a run once per cutoff, submits approved ones, and books confirmed ones
export const payoutsIntervalMs = 10 * 60_000;
export const payoutsJobName = 'payouts';
// Blocks on top of a payout's, its own included, before it is booked (PO-7)
export const payoutConfirmations = 15;

export interface PayoutsJobOptions {
  readonly repository: PayoutRepository;
  readonly wallet: PayoutWallet;
  readonly blockfrost: BlockfrostClient;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  // The payout asset (PO-2): USDM on Cardano in v1
  readonly asset: Asset;
  // Payouts below it roll over (PO-1)
  readonly minimum: MicroUsd;
  // Mainnet runs wait for an operator (PO-6, AR10)
  readonly needsApproval: boolean;
}

export interface PayoutsJobResult {
  readonly built: string | undefined;
  readonly submitted: number;
  readonly confirmed: number;
  readonly failed: number;
}

/**
 * Payouts (PO-1 to PO-8). Each run: build the run due at the latest cutoff once, if the wallet covers it
 * (PO-5); submit approved runs (PO-6); book each transaction once it has its confirmations, and fail one
 * the chain can no longer take, which leaves its earnings for the next run (PO-7). Every step is safe to
 * repeat (PO-4, WK-2).
 */
export const createPayoutsJob = ({ repository, wallet, blockfrost, clock, ids, logger, asset, minimum, needsApproval }: PayoutsJobOptions) => {
  const unit = blockfrostUnit(asset);

  const build = async (id: string, cutoff: Date): Promise<string | undefined> => {
    const dues = (await repository.serviceDues(cutoff)).filter(due => due.asset === asset.name);
    const planned = planPayouts(dues, minimum);
    if (planned.length === 0) {
      await repository.saveRun({ id, cutoff, status: 'empty', asset: asset.name, payouts: [], transactions: [] });

      return id;
    }

    const quantities = planned.map(payout => usdToAtomic(payout.amount, asset.decimals));
    const needed = quantities.reduce((sum, quantity) => sum + quantity, 0n);
    const held = (await blockfrost.addressAmounts(wallet.address)).get(unit) ?? 0n;
    if (held < needed) {
      // PO-5: stop and alert. The next run tries again, once the wallet is funded.
      const problem = `The payout wallet holds ${held} of the ${needed} atomic units the run needs`;
      await repository.stopRun({ id, cutoff, asset: asset.name, problem });
      logger.error({ runId: id, held: held.toString(), needed: needed.toString(), alert: true }, 'A payout run stopped: the payout wallet doesn\'t cover it');

      return undefined;
    }

    const validUntil = new Date(clock.now().getTime() + payoutValidityMs);
    const withIds = planned.map((payout, index) => ({ ...payout, id: `po_${ids.next()}`, quantity: quantities[index]! }));
    const batches = batchPayouts(withIds);
    const transactions = [];
    try {
      for (const [index, batch] of batches.entries()) {
        const built = await wallet.build({ outputs: batch.map(payout => ({ address: payout.address, quantity: payout.quantity })), validUntil });
        transactions.push({ index, txHash: built.txHash, cbor: built.cbor, validUntil });
      }
    }
    catch (error) {
      if (!(error instanceof PayoutBuildError))
        throw error;
      await repository.stopRun({ id, cutoff, asset: asset.name, problem: error.message });
      logger.error({ runId: id, error, alert: true }, 'A payout run stopped: its transactions couldn\'t be built');

      return undefined;
    }

    await repository.saveRun({
      id,
      cutoff,
      status: needsApproval ? 'awaiting_approval' : 'approved',
      asset: asset.name,
      payouts: batches.flatMap((batch, index) => batch.map(payout => ({ ...payout, transactionIndex: index }))),
      transactions,
    });
    const total = planned.reduce((sum, payout) => sum + payout.amount, 0n);
    logger.warn({ runId: id, payouts: planned.length, total: total.toString(), transactions: transactions.length, notice: true },
      needsApproval ? 'A payout run waits for an operator\'s approval' : 'A payout run was built');

    return id;
  };

  const submit = async (runId: string): Promise<{ submitted: number; failed: number }> => {
    let submitted = 0;
    let failed = 0;
    const now = clock.now();
    for (const transaction of (await repository.transactions(runId)).filter(item => item.status === 'built')) {
      // Past its window, the chain would refuse it: the run is built again and approved again
      if (now >= transaction.validUntil) {
        await repository.setRunStatus(runId, 'stopped', 'The approved transactions expired before they were submitted');
        logger.error({ runId, alert: true }, 'An approved payout run expired before it was submitted: it is built again for a new approval');

        return { submitted, failed };
      }
      try {
        await blockfrost.submitTransaction(transaction.cbor);
        await repository.markSubmitted(runId, transaction.index);
        submitted += 1;
      }
      catch (error) {
        if (!(error instanceof TransactionRejectedError))
          throw error;
        await repository.failTransaction(runId, transaction.index);
        logger.error({ runId, txHash: transaction.txHash, alert: true }, 'The chain refused a payout transaction: its payouts wait for the next run');
        failed += 1;
      }
    }
    await repository.setRunStatus(runId, 'submitted');

    return { submitted, failed };
  };

  const follow = async (runId: string, assetName: string): Promise<{ confirmed: number; failed: number }> => {
    let confirmed = 0;
    let failed = 0;
    const transactions = await repository.transactions(runId);
    const waiting = transactions.filter(item => item.status === 'submitted');
    if (waiting.length > 0) {
      const tip = await blockfrost.latestBlockHeight();
      for (const transaction of waiting) {
        const height = await blockfrost.transactionHeight(transaction.txHash);
        if (height !== undefined && tip - height + 1 >= payoutConfirmations) {
          await repository.confirmTransaction({ runId, index: transaction.index, asset: assetName });
          logger.info({ runId, txHash: transaction.txHash }, 'A payout transaction was confirmed and booked');
          confirmed += 1;
        }
        // Not on chain once its window passed: it can never land, so nothing was paid
        else if (height === undefined && clock.now() > transaction.validUntil) {
          await repository.failTransaction(runId, transaction.index);
          logger.error({ runId, txHash: transaction.txHash, alert: true }, 'A payout transaction never landed: its payouts wait for the next run');
          failed += 1;
        }
      }
    }

    const statuses = (await repository.transactions(runId)).map(item => item.status);
    if (!statuses.some(status => status === 'built' || status === 'submitted')) {
      const lost = statuses.filter(status => status === 'failed').length;
      await repository.setRunStatus(runId, lost === 0 ? 'confirmed' : 'failed', lost === 0 ? undefined : `${lost} of ${statuses.length} transactions failed`);
    }

    return { confirmed, failed };
  };

  return async (): Promise<PayoutsJobResult> => {
    const cutoff = payoutCutoff(clock.now());
    const id = payoutRunId(cutoff);
    const existing = await repository.findRun(id);
    let built: string | undefined;
    const expired = existing?.status === 'awaiting_approval'
      && (await repository.transactions(id)).some(transaction => clock.now() >= transaction.validUntil);
    if (!existing || existing.status === 'stopped' || expired)
      built = await build(id, cutoff);

    let submitted = 0;
    let confirmed = 0;
    let failed = 0;
    for (const run of await repository.runsWithStatus(['approved'])) {
      const result = await submit(run.id);
      submitted += result.submitted;
      failed += result.failed;
    }
    for (const run of await repository.runsWithStatus(['submitted'])) {
      const result = await follow(run.id, run.asset);
      confirmed += result.confirmed;
      failed += result.failed;
    }

    return { built, submitted, confirmed, failed };
  };
};
