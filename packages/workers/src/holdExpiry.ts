import type { Clock, Logger } from '@servicerouter/common';
import type { PlatformConfig } from '@servicerouter/core';
import type { Ledger, PaymentRepository } from '@servicerouter/db';

// WK-1: one runner across replicas
export const holdExpiryLockId = 7_301_746_201;
// LG-9 and the jobs table in docs/architecture/workers.md
export const holdExpiryIntervalMs = 60_000;
const defaultBatchSize = 100;

/**
 * How old a hold must be before the worker finishes it: longer than the proxy's total timeout, so no
 * request still serving it can finish it too. At least 5 minutes.
 */
export const holdTtlMs = (config: Pick<PlatformConfig, 'timeouts'>): number => Math.max(5 * 60_000, 2 * config.timeouts.requestMs);

export interface HoldExpiryOptions {
  readonly payments: Pick<PaymentRepository, 'listExpiredHolds'>;
  readonly ledger: Pick<Ledger, 'capture' | 'release'>;
  // WK-3
  readonly clock: Clock;
  readonly ttlMs: number;
  // The platform's fee on a capture (LG-4)
  readonly feeBps: number;
  readonly logger: Logger;
  readonly batchSize?: number;
}

export interface HoldExpiryResult {
  readonly captured: number;
  readonly released: number;
  readonly failed: number;
}

/** Some expired holds couldn't be finished. They are retried on the next run, and the job stays stale (WK-4). */
export class HoldExpiryFailedError extends Error {
  constructor(readonly result: HoldExpiryResult) {
    super(`${result.failed} expired holds couldn't be finished`);
  }
}

/**
 * Hold expiry (LG-9): finishes every payment still `held` after the TTL, as the recorded decision
 * says (rule 5). Billable is captured. Not billable, or no decision at all, is released, so a buyer is
 * never charged without one. Capture and release move money once per payment, so a rerun after a
 * crash moves nothing twice (WK-2). Throws HoldExpiryFailedError after the run when any failed.
 */
export const createHoldExpiry = ({
  payments, ledger, clock, ttlMs, feeBps, logger, batchSize = defaultBatchSize,
}: HoldExpiryOptions) => async (): Promise<HoldExpiryResult> => {
  const createdBefore = new Date(clock.now().getTime() - ttlMs);
  let captured = 0;
  let released = 0;
  let failed = 0;
  let after: { readonly createdAt: Date; readonly id: string } | undefined;
  for (;;) {
    const page = await payments.listExpiredHolds({ createdBefore, limit: batchSize, ...(after ? { after } : {}) });
    // One at a time: each is a ledger transaction, and the proxy's captures share the fee row with them
    for (const payment of page) {
      try {
        if (payment.decision === 'billable') {
          await ledger.capture({ paymentId: payment.id, feeBps });
          captured += 1;
        }
        else {
          await ledger.release({ paymentId: payment.id });
          released += 1;
        }
      }
      catch (error) {
        failed += 1;
        logger.error({ error, paymentId: payment.id, decision: payment.decision ?? null }, 'Failed to finish an expired hold');
      }
    }
    const last = page.at(-1);
    if (!last || page.length < batchSize)
      break;
    after = { createdAt: last.createdAt, id: last.id };
  }

  const result = { captured, released, failed };
  // The scheduler's line carries these counts at info (L-8)
  if (captured + released + failed > 0)
    logger.debug(result, 'Finished expired holds');
  if (failed > 0)
    throw new HoldExpiryFailedError(result);

  return result;
};
