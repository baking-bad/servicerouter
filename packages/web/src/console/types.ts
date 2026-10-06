import type { PaymentMethod } from '../api/types';

// The Platform API's answers the console reads (WB-8), behind the master key. Amounts are USD decimal
// strings (CK-4), times ISO 8601.

export interface Account {
  readonly id: string;
  readonly email: string | null;
  readonly emailConfirmed: boolean;
  // The account's top-up page and deposit address (DP-1, DP-5), null while deposits are off
  readonly topupUrl: string | null;
  readonly depositAddress: { readonly address: string; readonly network: string; readonly asset: string } | null;
  readonly createdAt: string;
}

/** `POST /v1/accounts`: the account and its master key, shown once (AK-1). */
export interface Signup extends Account {
  readonly masterKey: string;
  readonly notice: string;
}

export interface Balance {
  readonly available: string;
  readonly held: string;
}

/** A payment key and its limits (AK-6). The key itself is shown only when it is created. */
export interface PaymentKey {
  readonly id: string;
  readonly label: string | null;
  readonly allowance: string | null;
  readonly dailyBudget: string;
  readonly maxPrice: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly spent: { readonly today: string; readonly total: string };
  readonly remaining: { readonly allowance: string | null; readonly dailyBudget: string };
}

export interface CreatedKey extends PaymentKey {
  readonly key: string;
}

/** Limits to set: on create, missing ones take their defaults; on change, `null` clears an optional one. */
export interface KeyLimits {
  readonly label?: string | null;
  readonly dailyBudget?: string;
  readonly allowance?: string | null;
  readonly maxPrice?: string | null;
  readonly expiresAt?: string | null;
}

export const paymentStatuses = ['held', 'verified', 'captured', 'settling', 'settled', 'released', 'cancelled', 'failed'] as const;
export type PaymentStatus = typeof paymentStatuses[number];

/** A payment as its buyer sees it (LG-7). */
export interface Payment {
  readonly id: string;
  readonly requestId: string | null;
  readonly kind: 'service' | 'routed';
  readonly rail: PaymentMethod;
  readonly serviceId: string | null;
  readonly routeKey: string | null;
  readonly targetHost: string | null;
  readonly targetPath: string | null;
  readonly amount: string;
  readonly status: PaymentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PaymentPage {
  readonly payments: readonly Payment[];
  readonly next: string | null;
}

/** `GET /v1/services`: one of the account's services. */
export interface OwnedService {
  readonly id: string;
  readonly state: 'pending' | 'live' | 'suspended';
  readonly revision: number | null;
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `GET /v1/services/{id}`: the active revision's config as submitted, and secret names only (SC-1). */
export interface ServiceDetail {
  readonly id: string;
  readonly state: OwnedService['state'];
  readonly revision: number;
  readonly config: { readonly mediaType: string; readonly text: string };
  readonly secrets: readonly { readonly name: string; readonly updatedAt: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Revision {
  readonly number: number;
  readonly active: boolean;
  readonly mediaType: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** `GET /v1/services/{id}/earnings` (LG-10). */
export interface Earnings {
  readonly serviceId: string;
  readonly calls: number;
  readonly earned: { readonly total: string; readonly byRail: Readonly<Partial<Record<PaymentMethod, string>>> };
  readonly fee: string;
  readonly paidOut: string;
  readonly pending: string;
  readonly nextPayoutDate: string;
}

export const hostStates = ['unverified', 'verified', 'missing', 'suspended'] as const;
export type HostState = typeof hostStates[number];

export interface HostStatus {
  readonly host: string;
  readonly state: HostState;
  readonly checkedAt: string | null;
  readonly problem: string | null;
  readonly missingSince: string | null;
  readonly suspendsAt: string | null;
}

/**
 * `GET /v1/services/{id}/status` and `POST …/verify` (OV-6, OV-7, OV-10): each upstream host's
 * verification, the token to publish, a payout change waiting for its confirmation, and notices.
 */
export interface ServiceStatus {
  readonly id: string;
  readonly state: OwnedService['state'];
  readonly revision: number;
  readonly verificationToken: string;
  readonly hosts: readonly HostStatus[];
  readonly payoutConfirmation: {
    readonly revision: number;
    readonly token: string;
    readonly expiresAt: string;
    readonly hosts: readonly { readonly host: string; readonly confirmed: boolean }[];
  } | null;
  readonly notices: readonly { readonly code: string; readonly host: string | null; readonly message: string }[];
}
