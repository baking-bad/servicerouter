import type { KeyKind } from './keys.js';

export interface Account {
  readonly id: string;
  readonly email: string | undefined;
  // Empty until email confirmation ships (step 9)
  readonly emailConfirmedAt: Date | undefined;
  readonly createdAt: Date;
}

export interface NewAccount {
  readonly id: string;
  readonly email: string | undefined;
  readonly createdAt: Date;
}

/** A stored key. Never the key itself: only its hash is stored, and records don't carry even that. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly accountId: string;
  readonly kind: KeyKind;
  readonly label: string | undefined;
  readonly createdAt: Date;
  readonly revokedAt: Date | undefined;
}

export interface NewApiKey {
  readonly id: string;
  readonly accountId: string;
  readonly kind: KeyKind;
  // hashApiKey of the key (AK-3)
  readonly keyHash: string;
  readonly label?: string;
  readonly createdAt: Date;
}

/** Port: the `accounts` table. */
export interface AccountRepository {
  create(account: NewAccount): Promise<Account>;
  findById(id: string): Promise<Account | undefined>;
}

/** Port: the `api_keys` table. Keys are looked up by hash only (AK-3). */
export interface ApiKeyRepository {
  insert(key: NewApiKey): Promise<ApiKeyRecord>;
  /** The key with this hash, unless it is revoked. */
  findActiveByHash(keyHash: string): Promise<ApiKeyRecord | undefined>;
  /** Revokes the account's key with this ID and returns it, or undefined when it isn't active. */
  revoke(key: { readonly id: string; readonly accountId: string; readonly revokedAt: Date }): Promise<ApiKeyRecord | undefined>;
}
