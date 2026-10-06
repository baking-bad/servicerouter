import type { MicroUsd } from '@servicerouter/common';

/** What one service owes its seller at a cutoff: net earnings minus what was paid out (PO-1). */
export interface ServiceDue {
  readonly serviceId: string;
  readonly sellerAccountId: string;
  // The payout address of the service's active revision (PO-2)
  readonly address: string;
  readonly amount: MicroUsd;
}

export interface PlannedPayout {
  readonly sellerAccountId: string;
  readonly address: string;
  readonly amount: MicroUsd;
  // Which services it pays, and how much of each: the next run subtracts these (PO-1)
  readonly items: readonly { readonly serviceId: string; readonly amount: MicroUsd }[];
}

// A payout run's outputs per transaction, well inside Cardano's 16 KiB limit (PO-3)
export const payoutOutputsPerTransaction = 40;
// How long a built run's transactions stay valid: an operator approves within it, or the run is built again
export const payoutValidityMs = 7 * 24 * 60 * 60 * 1_000;

/**
 * The 1st of the month, 00:00 UTC, at or before `now`: the cutoff of the run due then (PO-1). Earnings
 * booked before it are paid in that run.
 */
export const payoutCutoff = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** The run's ID for a cutoff. One run per cutoff (PO-4). */
export const payoutRunId = (cutoff: Date): string => `run_${cutoff.toISOString().slice(0, 10)}`;

/**
 * Groups what services owe into payouts per seller and payout address (PO-1). A payout below the
 * minimum rolls over to the next run. Services with nothing due are left out. Deterministic: sorted
 * by seller, then address, then service.
 */
export const planPayouts = (dues: readonly ServiceDue[], minimum: MicroUsd): readonly PlannedPayout[] => {
  const groups = new Map<string, { sellerAccountId: string; address: string; items: { serviceId: string; amount: MicroUsd }[] }>();
  for (const due of dues) {
    if (due.amount <= 0n)
      continue;
    const key = `${due.sellerAccountId}\n${due.address}`;
    const group = groups.get(key) ?? { sellerAccountId: due.sellerAccountId, address: due.address, items: [] };
    group.items.push({ serviceId: due.serviceId, amount: due.amount });
    groups.set(key, group);
  }

  return [...groups.values()]
    .map(group => ({
      sellerAccountId: group.sellerAccountId,
      address: group.address,
      amount: group.items.reduce((sum, item) => sum + item.amount, 0n) as MicroUsd,
      items: group.items.sort((left, right) => left.serviceId.localeCompare(right.serviceId)),
    }))
    .filter(payout => payout.amount >= minimum)
    .sort((left, right) => left.sellerAccountId.localeCompare(right.sellerAccountId) || left.address.localeCompare(right.address));
};

/** Splits payouts into the transactions of a run, in order (PO-3). */
export const batchPayouts = <TPayout>(payouts: readonly TPayout[], size = payoutOutputsPerTransaction): readonly (readonly TPayout[])[] =>
  Array.from({ length: Math.ceil(payouts.length / size) }, (_, index) => payouts.slice(index * size, (index + 1) * size));

/** A USD amount in the payout asset's atomic units, 1:1, for a pegged asset with this many decimals. */
export const usdToAtomic = (amount: MicroUsd, decimals: number): bigint =>
  decimals >= 6 ? amount * 10n ** BigInt(decimals - 6) : amount / 10n ** BigInt(6 - decimals);
