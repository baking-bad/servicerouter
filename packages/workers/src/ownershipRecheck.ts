import type { OwnershipVerifier, RecheckResult } from '@servicerouter/core';

// WK-1: one runner across replicas
export const ownershipRecheckLockId = 7_301_746_203;
// OV-6: each host is due once a day, at its own time. Every few minutes the job checks the hosts due by
// then, so the checks spread over the day.
export const ownershipRecheckJobIntervalMs = 5 * 60_000;
export const ownershipRecheckBatchSize = 50;
export const ownershipRecheckJobName = 'ownership_recheck';

/** Some checks failed. They are due again on the next run, and the job stays stale (WK-4). */
export class OwnershipRecheckFailedError extends Error {
  constructor(readonly result: RecheckResult) {
    super(`${result.failed} ownership checks failed`);
  }
}

/**
 * The ownership re-check (OV-6): drops expired payout changes, then checks the hosts of live and
 * suspended services that are due, and the waiting payout changes that are due. A host that can't be
 * fetched is a result of the check, not a failure: only an error of our own fails the run.
 */
export const createOwnershipRecheck = ({ verifier, batchSize = ownershipRecheckBatchSize }: {
  readonly verifier: Pick<OwnershipVerifier, 'recheck'>;
  readonly batchSize?: number;
}) => async (): Promise<RecheckResult> => {
  const result = await verifier.recheck({ actor: { kind: 'job', id: ownershipRecheckJobName }, limit: batchSize });
  if (result.failed > 0)
    throw new OwnershipRecheckFailedError(result);

  return result;
};
