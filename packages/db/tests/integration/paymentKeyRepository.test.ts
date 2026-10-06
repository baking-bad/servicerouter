import { fixtureTime } from '@servicerouter/testing';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '@servicerouter/common';
import { hashApiKey } from '@servicerouter/core';
import { createTestDatabase, type TestDatabase } from '@servicerouter/testing';

import { apiKeys, createAccountRepository, createApiKeyRepository, createKeyStore, createPaymentKeyRepository } from '../../src/index.js';

let database: TestDatabase;
let counter = 0;
const createdAt = new Date(fixtureTime(0, 5, 12, 0, 0, 0));

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

const newAccount = async (): Promise<string> => {
  counter += 1;
  const id = `acc_${counter}`;
  await createAccountRepository({ db: database.db }).create({ id, email: undefined, createdAt });

  return id;
};

const insertKey = async (accountId: string, limits: { allowance?: bigint; maxPrice?: bigint; expiresAt?: Date } = {}) => {
  counter += 1;
  const hash = hashApiKey(Secret.from(`sr_test_key_${counter}`));
  const key = await createPaymentKeyRepository({ db: database.db }).insert({
    id: `key_${counter}`,
    accountId,
    keyHash: hash,
    label: 'n8n',
    createdAt,
    allowance: limits.allowance,
    dailyBudget: 5_000_000n,
    maxPrice: limits.maxPrice,
    expiresAt: limits.expiresAt,
  });

  return { key, hash };
};

const pgError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  }
  catch (error) {
    return (error as { cause?: { constraint?: string } }).cause ?? error;
  }
  throw new Error('Expected a rejection');
};

describe('payment keys (AK-6, AK-7)', () => {
  it('stores a payment key with its limits, and finds it by hash for the rails\' KeyStore (PR-4)', async () => {
    const accountId = await newAccount();
    const expiresAt = new Date(fixtureTime(2, 31, 0, 0, 0, 0));
    const { key, hash } = await insertKey(accountId, { allowance: 20_000_000n, maxPrice: 50_000n, expiresAt });

    expect(key).toEqual({
      id: key.id, accountId, label: 'n8n', createdAt, revokedAt: undefined,
      allowance: 20_000_000n, dailyBudget: 5_000_000n, maxPrice: 50_000n, expiresAt,
    });
    expect(await createKeyStore({ db: database.db }).findByHash(hash)).toEqual(key);
    expect(await createKeyStore({ db: database.db }).findByHash(hashApiKey(Secret.from('sr_test_unknown')))).toBeUndefined();
  });

  it('changes limits and the label, clearing one with undefined, only on the owner\'s active key', async () => {
    const [accountId, other] = [await newAccount(), await newAccount()];
    const { key } = await insertKey(accountId, { allowance: 1n, maxPrice: 2n });
    const keys = createPaymentKeyRepository({ db: database.db });

    const updated = await keys.update({ id: key.id, accountId, changes: { allowance: undefined, dailyBudget: 7n, label: 'cron' } });

    expect(updated).toMatchObject({ allowance: undefined, dailyBudget: 7n, maxPrice: 2n, label: 'cron' });
    expect(await keys.update({ id: key.id, accountId: other, changes: { dailyBudget: 1n } })).toBeUndefined();
    expect(await keys.find({ id: key.id, accountId })).toEqual(updated);
  });

  it('revokes a key once: it can\'t be found by hash or changed after', async () => {
    const accountId = await newAccount();
    const { key, hash } = await insertKey(accountId);
    const keys = createPaymentKeyRepository({ db: database.db });

    const revoked = await keys.revoke({ id: key.id, accountId, revokedAt: createdAt });

    expect(revoked?.revokedAt).toEqual(createdAt);
    expect(await keys.revoke({ id: key.id, accountId, revokedAt: createdAt })).toBeUndefined();
    expect(await keys.findActiveByHash(hash)).toBeUndefined();
    expect(await keys.update({ id: key.id, accountId, changes: { label: 'x' } })).toBeUndefined();
    expect((await keys.list(accountId)).map(item => item.id)).toEqual([key.id]);
  });

  it('lists only payment keys, never the master key, and never finds a master key as a payment key', async () => {
    const accountId = await newAccount();
    const masterHash = hashApiKey(Secret.from(`srm_test_master_${accountId}`));
    await createApiKeyRepository({ db: database.db }).insert({ id: `key_master_${accountId}`, accountId, kind: 'master', keyHash: masterHash, createdAt });
    const { key } = await insertKey(accountId);

    expect((await createPaymentKeyRepository({ db: database.db }).list(accountId)).map(item => item.id)).toEqual([key.id]);
    expect(await createKeyStore({ db: database.db }).findByHash(masterHash)).toBeUndefined();
  });

  it('refuses a payment key without a daily budget, a negative limit, or a master key with limits', async () => {
    const accountId = await newAccount();
    const row = (changes: Record<string, unknown>) => ({ id: `key_bad_${counter += 1}`, accountId, kind: 'payment' as const, keyHash: 'a'.repeat(64 - String(counter).length) + counter, createdAt, ...changes });

    expect(await pgError(database.db.insert(apiKeys).values(row({ dailyBudget: null })))).toMatchObject({ constraint: 'api_keys_payment_limits_check' });
    expect(await pgError(database.db.insert(apiKeys).values(row({ dailyBudget: -1n })))).toMatchObject({ constraint: 'api_keys_limits_check' });
    expect(await pgError(database.db.insert(apiKeys).values(row({ kind: 'master', dailyBudget: 1n })))).toMatchObject({ constraint: 'api_keys_payment_limits_check' });
  });
});
