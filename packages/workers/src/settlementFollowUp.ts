import type { Logger } from '@servicerouter/common';
import type { JsonObject, Payment } from '@servicerouter/core';
import type { Ledger, PaymentRepository } from '@servicerouter/db';
import {
  encodeSettleReceipt, errorReason, fromMppSettlementRequest, fromSettlementRequest, settlementPending, type Facilitator,
  type MppSettlementCheck,
} from '@servicerouter/payments';

// WK-1: one runner across replicas
export const settlementFollowUpLockId = 7_301_746_202;
// The jobs table in docs/architecture/workers.md
export const settlementFollowUpIntervalMs = 30_000;
const defaultBatchSize = 100;

export interface SettlementFollowUpOptions {
  readonly payments: Pick<PaymentRepository, 'listSettling' | 'changeStatus'>;
  readonly ledger: Pick<Ledger, 'settle'>;
  readonly facilitatorFor: (network: string) => Facilitator | undefined;
  readonly assetName: (network: string, address: string) => string | undefined;
  // Reads an MPP transaction's receipt on the Tempo RPC (PR-9). Without it, MPP payments wait.
  readonly mppCheck?: MppSettlementCheck;
  // The platform's fee on a settlement (LG-4)
  readonly feeBps: number;
  readonly logger: Logger;
  readonly batchSize?: number;
}

export interface SettlementFollowUpResult {
  readonly settled: number;
  readonly failed: number;
  // Broadcast, not final yet: tried again next run
  readonly pending: number;
  // The facilitator didn't answer: tried again next run, and the run fails
  readonly unknown: number;
  // Couldn't be tried: no settle request, facilitator or Tempo RPC, or asset
  readonly skipped: number;
}

/** Some settlements couldn't be decided. They are tried again next run, and the job stays stale (WK-4). */
export class SettlementFollowUpError extends Error {
  constructor(readonly result: SettlementFollowUpResult) {
    super(`${result.unknown + result.skipped} settling payments couldn't be decided`);
  }
}

/**
 * Settlement follow-up (WK-6, PR-12): repeats the identical settle for every `settling` x402 payment,
 * and reads the receipt of every `settling` MPP payment's transaction (PR-9), never broadcasting it.
 * Settled → books the earnings, flagged for review when the buyer got no response (no receipt was
 * sent). Definitively failed or expired → `failed`, nothing booked. Pending → next run. The Ledger's
 * settle moves money once, so a rerun after a crash books nothing twice (WK-2).
 */
export const createSettlementFollowUp = ({
  payments, ledger, facilitatorFor, assetName, mppCheck, feeBps, logger, batchSize = defaultBatchSize,
}: SettlementFollowUpOptions) => async (): Promise<SettlementFollowUpResult> => {
  const counts = { settled: 0, failed: 0, pending: 0, unknown: 0, skipped: 0 };

  // MPP: the transaction's receipt by its hash on the Tempo RPC
  const followMpp = async (payment: Payment, settlementRequest: JsonObject | undefined): Promise<void> => {
    const request = fromMppSettlementRequest(settlementRequest);
    const asset = payment.network === undefined || payment.asset === undefined ? undefined : assetName(payment.network, payment.asset);
    if (!request || !mppCheck || !asset) {
      counts.skipped += 1;
      logger.error({ paymentId: payment.id, network: payment.network ?? null }, 'A settling MPP payment has no settlement request, Tempo RPC, or asset to check it with');
      return;
    }

    try {
      const result = await mppCheck(request);
      if (result.status === 'settled') {
        await ledger.settle({
          paymentId: payment.id,
          feeBps,
          asset,
          transactionHash: request.transactionHash,
          receipt: payment.receipt ?? result.receipt,
          // The buyer paid, and the response never went out (PR-12)
          needsReview: payment.receipt === undefined,
        });
        counts.settled += 1;
      }
      else if (result.status === 'failed') {
        await payments.changeStatus({ paymentId: payment.id, to: 'failed', settlementRequest: null });
        counts.failed += 1;
        logger.warn({ paymentId: payment.id, reason: result.reason }, 'An MPP payment failed for good. Nothing was booked.');
      }
      else
        counts.pending += 1;
    }
    catch (error) {
      counts.unknown += 1;
      logger.warn({ reason: errorReason(error), paymentId: payment.id }, 'An MPP payment is still undecided');
    }
  };

  let after: { readonly createdAt: Date; readonly id: string } | undefined;
  for (;;) {
    const page = await payments.listSettling({ limit: batchSize, ...(after ? { after } : {}) });
    // One at a time: each is a facilitator or RPC call, then a ledger transaction
    for (const { payment, settlementRequest } of page) {
      if (payment.rail === 'mpp') {
        await followMpp(payment, settlementRequest);
        continue;
      }
      const request = fromSettlementRequest(settlementRequest);
      const facilitator = payment.network === undefined ? undefined : facilitatorFor(payment.network);
      const asset = payment.network === undefined || payment.asset === undefined ? undefined : assetName(payment.network, payment.asset);
      if (!request || !facilitator || !asset) {
        counts.skipped += 1;
        logger.error({ paymentId: payment.id, network: payment.network ?? null }, 'A settling payment has no settle request, facilitator, or asset to repeat it with');
        continue;
      }

      try {
        const result = await facilitator.settle(request.paymentPayload, request.paymentRequirements);
        if (result.success) {
          await ledger.settle({
            paymentId: payment.id,
            feeBps,
            asset,
            transactionHash: result.transaction || payment.transactionHash,
            receipt: payment.receipt ?? encodeSettleReceipt(result),
            // The buyer paid, and the response never went out (PR-12)
            needsReview: payment.receipt === undefined,
          });
          counts.settled += 1;
        }
        else if (result.errorReason === settlementPending)
          counts.pending += 1;
        else {
          await payments.changeStatus({ paymentId: payment.id, to: 'failed', settlementRequest: null });
          counts.failed += 1;
          logger.warn({ paymentId: payment.id, reason: result.errorReason ?? null }, 'A settlement failed for good. Nothing was booked.');
        }
      }
      catch (error) {
        counts.unknown += 1;
        logger.warn({ error, paymentId: payment.id }, 'A settlement is still undecided');
      }
    }
    const last = page.at(-1);
    if (!last || page.length < batchSize)
      break;
    after = { createdAt: last.payment.createdAt, id: last.payment.id };
  }

  if (counts.settled + counts.failed > 0)
    logger.info(counts, 'Followed up settlements');
  if (counts.unknown + counts.skipped > 0)
    throw new SettlementFollowUpError(counts);

  return counts;
};
