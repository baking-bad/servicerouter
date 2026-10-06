import type { ServiceState } from '../service/runtime.js';

/** A host's ownership state for one account (OV-4). */
export const hostStates = ['unverified', 'verified', 'missing', 'suspended'] as const;
export type HostState = typeof hostStates[number];

/** Why a check didn't find the account's token. Never anything from the response. */
export const hostProblems = ['file_not_found', 'fetch_failed', 'invalid_file', 'token_missing'] as const;
export type HostProblem = typeof hostProblems[number];

// OV-4: `missing` starts a 7-day grace period before the host is suspended
export const ownershipGracePeriodMs = 7 * 24 * 60 * 60 * 1_000;
// OV-6: every host in use is checked again once a day
export const ownershipRecheckIntervalMs = 24 * 60 * 60 * 1_000;
// OV-10: a payout confirmation token expires 7 days after it was issued
export const payoutConfirmationTtlMs = 7 * 24 * 60 * 60 * 1_000;

/** What is stored about a host for an account. */
export interface HostRecord {
  readonly state: HostState;
  // When the token was last found missing after the host was verified: the start of the grace period
  readonly missingSince: Date | undefined;
}

export interface HostCheckOutcome {
  readonly state: HostState;
  readonly missingSince: Date | undefined;
  // When the job checks the host next (OV-6)
  readonly nextCheckAt: Date;
}

/**
 * The next state of a host after a check (OV-4). Found → `verified`, from any state. Not found: a
 * `verified` host goes `missing` and its grace period starts, a `missing` one is suspended once the
 * grace period is over, and the others stay as they are. A `missing` host is checked again at the end
 * of its grace period if that comes before the next daily check.
 */
export const nextHostState = (current: HostRecord | undefined, found: boolean, now: Date): HostCheckOutcome => {
  const daily = new Date(now.getTime() + ownershipRecheckIntervalMs);
  if (found)
    return { state: 'verified', missingSince: undefined, nextCheckAt: daily };

  const state = current?.state ?? 'unverified';
  if (state === 'verified') {
    const graceEnd = new Date(now.getTime() + ownershipGracePeriodMs);

    return { state: 'missing', missingSince: now, nextCheckAt: graceEnd < daily ? graceEnd : daily };
  }
  if (state === 'missing') {
    const missingSince = current?.missingSince ?? now;
    const graceEnd = new Date(missingSince.getTime() + ownershipGracePeriodMs);
    if (now >= graceEnd)
      return { state: 'suspended', missingSince, nextCheckAt: daily };

    return { state: 'missing', missingSince, nextCheckAt: graceEnd < daily ? graceEnd : daily };
  }

  return { state, missingSince: current?.missingSince, nextCheckAt: daily };
};

/** When a `missing` host is suspended, unless its token comes back. */
export const graceEndOf = (missingSince: Date): Date => new Date(missingSince.getTime() + ownershipGracePeriodMs);

/**
 * A service's state from the states of its upstream hosts (SR-8, OV-5): `suspended` while any host is,
 * `live` when every host is verified or still in its grace period, `pending` otherwise. A host with no
 * record is `unverified`.
 */
export const serviceStateFor = (states: readonly (HostState | undefined)[]): ServiceState => {
  if (states.includes('suspended'))
    return 'suspended';

  return states.every(state => state === 'verified' || state === 'missing') ? 'live' : 'pending';
};
