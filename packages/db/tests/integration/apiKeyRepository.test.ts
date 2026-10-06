import { fixtureTime } from '@servicerouter/testing';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '@servicerouter/testing';

import { apiKeys, createAccountRepository, createApiKeyRepository } from '../../src/index.js';

let database: TestDatabase;
let counter = 0;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

const createdAt = new Date(fixtureTime(-9, 1, 0, 0, 0, 0));
const hash = (seed: number) => seed.toString(16).padStart(64, '0');

const newAccount = async (): Promise<string> => {
  counter += 1;
  const account = await createAccountRepository({ db: database.db }).create({ id: `acc_${counter}`, email: undefined, createdAt });

  return account.id;
};

const pgError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  }
  catch (error) {
    return (error as { cause?: { code?: string; constraint?: string } }).cause ?? error;
  }
  throw new Error('Expected a rejection');
};

describe('accounts', () => {
  it('stores an account with an optional email and no confirmation', async () => {
    const accounts = createAccountRepository({ db: database.db });

    const created = await accounts.create({ id: 'acc_email', email: 'owner@example.com', createdAt });

    expect(created).toEqual({ id: 'acc_email', email: 'owner@example.com', emailConfirmedAt: undefined, createdAt });
    expect(await accounts.findById('acc_email')).toEqual(created);
    expect(await accounts.findById('acc_missing')).toBeUndefined();
  });
});

describe('api_keys (AK-3)', () => {
  it('finds an active key by its hash, and returns the record without the hash', async () => {
    const accountId = await newAccount();
    const keys = createApiKeyRepository({ db: database.db });
    await keys.insert({ id: 'key_find', accountId, kind: 'master', keyHash: hash(1), createdAt });

    const found = await keys.findActiveByHash(hash(1));

    expect(found).toEqual({ id: 'key_find', accountId, kind: 'master', label: undefined, createdAt, revokedAt: undefined });
    expect(await keys.findActiveByHash(hash(2))).toBeUndefined();
  });

  it('stops finding a key once it is revoked, and revokes only an active key of that account', async () => {
    const accountId = await newAccount();
    const otherAccountId = await newAccount();
    const keys = createApiKeyRepository({ db: database.db });
    await keys.insert({ id: 'key_revoke', accountId, kind: 'master', keyHash: hash(3), createdAt });
    const revokedAt = new Date(fixtureTime(-9, 2, 0, 0, 0, 0));

    expect(await keys.revoke({ id: 'key_revoke', accountId: otherAccountId, revokedAt })).toBeUndefined();
    expect(await keys.revoke({ id: 'key_revoke', accountId, revokedAt })).toMatchObject({ id: 'key_revoke', revokedAt });
    expect(await keys.revoke({ id: 'key_revoke', accountId, revokedAt })).toBeUndefined();
    expect(await keys.findActiveByHash(hash(3))).toBeUndefined();
  });

  it('allows one active master key per account, and any number of revoked ones', async () => {
    const accountId = await newAccount();
    const keys = createApiKeyRepository({ db: database.db });
    await keys.insert({ id: 'key_master_1', accountId, kind: 'master', keyHash: hash(4), createdAt });

    expect(await pgError(keys.insert({ id: 'key_master_2', accountId, kind: 'master', keyHash: hash(5), createdAt })))
      .toMatchObject({ code: '23505', constraint: 'api_keys_active_master_idx' });

    await keys.revoke({ id: 'key_master_1', accountId, revokedAt: createdAt });
    await keys.insert({ id: 'key_master_3', accountId, kind: 'master', keyHash: hash(6), createdAt });
    await keys.revoke({ id: 'key_master_3', accountId, revokedAt: createdAt });
    await keys.insert({ id: 'key_master_4', accountId, kind: 'master', keyHash: hash(7), createdAt });
    await keys.insert({ id: 'key_payment_1', accountId, kind: 'payment', keyHash: hash(8), createdAt });
    await keys.insert({ id: 'key_payment_2', accountId, kind: 'payment', keyHash: hash(9), createdAt });
    expect(await keys.findActiveByHash(hash(7))).toMatchObject({ id: 'key_master_4' });
  });

  it('refuses a hash that is already stored, or isn\'t a SHA-256 in hex', async () => {
    const accountId = await newAccount();
    const keys = createApiKeyRepository({ db: database.db });
    await keys.insert({ id: 'key_unique', accountId, kind: 'payment', keyHash: hash(10), createdAt });

    expect(await pgError(keys.insert({ id: 'key_duplicate', accountId, kind: 'payment', keyHash: hash(10), createdAt })))
      .toMatchObject({ code: '23505', constraint: 'api_keys_key_hash_idx' });
    expect(await pgError(keys.insert({ id: 'key_plain', accountId, kind: 'payment', keyHash: 'sr_test_not-a-hash', createdAt })))
      .toMatchObject({ code: '23514', constraint: 'api_keys_key_hash_check' });
  });

  it('has no column for the key itself: only its hash (AK-3)', async () => {
    const { rows } = await database.db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'api_keys' order by ordinal_position`,
    );

    expect(rows.map(row => row.column_name)).toEqual(['id', 'account_id', 'kind', 'key_hash', 'label', 'created_at', 'revoked_at']);
    expect(apiKeys.keyHash.name).toBe('key_hash');
  });
});
