import type { Clock, IdGenerator, RequestId, Secret } from '@servicerouter/common';
import {
  generateApiKey, hashApiKey, InvalidKeyError, type Account, type AuditLog, type KeyPrefixes, type RandomSource,
} from '@servicerouter/core';
import {
  createAccountRepository, createApiKeyRepository, createAuditLogRepository, withTransaction, type Database,
  type DatabaseTransaction,
} from '@servicerouter/db';

export const accountIdPrefix = 'acc_';
export const keyIdPrefix = 'key_';

export interface AccountServiceOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: RandomSource;
  readonly keyPrefixes: KeyPrefixes;
  // The audit log inside a change's transaction. Default: the audit_log repository on it.
  readonly auditLog?: (tx: DatabaseTransaction) => AuditLog;
}

export interface CreatedAccount {
  readonly account: Account;
  // Shown once, in the response that creates it (AK-3)
  readonly masterKey: Secret;
}

export interface AccountService {
  /** Creates an account with its master key, and the audit entry, in one transaction (AK-1, AK-16). */
  create(input: { readonly email?: string; readonly requestId: RequestId }): Promise<CreatedAccount>;
  get(accountId: string): Promise<Account | undefined>;
  /**
   * Revokes the master key the caller used and issues a new one, with the audit entry, in one
   * transaction (AK-5, AK-16). Throws InvalidKeyError if that key was revoked in the meantime.
   */
  rotateMasterKey(input: { readonly accountId: string; readonly keyId: string; readonly requestId: RequestId }): Promise<Secret>;
}

// A key that never reaches the client, because its transaction failed, is wiped at once
const destroyOnFailure = async <TResult>(key: Secret, work: () => Promise<TResult>): Promise<TResult> => {
  try {
    return await work();
  }
  catch (error) {
    key.destroy();
    throw error;
  }
};

export const createAccountService = ({
  db,
  clock,
  ids,
  random,
  keyPrefixes,
  auditLog = tx => createAuditLogRepository({ db: tx, clock, ids }),
}: AccountServiceOptions): AccountService => ({
  create: async ({ email, requestId }) => {
    const accountId = `${accountIdPrefix}${ids.next()}`;
    const keyId = `${keyIdPrefix}${ids.next()}`;
    const masterKey = generateApiKey('master', keyPrefixes, random);
    const createdAt = clock.now();

    const account = await destroyOnFailure(masterKey, () => withTransaction(db, async tx => {
      const created = await createAccountRepository({ db: tx }).create({ id: accountId, email, createdAt });
      await createApiKeyRepository({ db: tx }).insert({
        id: keyId,
        accountId,
        kind: 'master',
        keyHash: hashApiKey(masterKey),
        createdAt,
      });
      await auditLog(tx).append({
        actor: { kind: 'account', id: accountId },
        action: 'account.create',
        subject: { kind: 'account', id: accountId },
        requestId,
        details: { masterKeyId: keyId },
      });

      return created;
    }));

    return { account, masterKey };
  },
  get: accountId => createAccountRepository({ db }).findById(accountId),
  rotateMasterKey: async ({ accountId, keyId, requestId }) => {
    const newKeyId = `${keyIdPrefix}${ids.next()}`;
    const masterKey = generateApiKey('master', keyPrefixes, random);
    const rotatedAt = clock.now();

    await destroyOnFailure(masterKey, () => withTransaction(db, async tx => {
      const keys = createApiKeyRepository({ db: tx });
      // The old key stops working when this commits (AK-5)
      const revoked = await keys.revoke({ id: keyId, accountId, revokedAt: rotatedAt });
      if (!revoked)
        throw new InvalidKeyError();

      await keys.insert({ id: newKeyId, accountId, kind: 'master', keyHash: hashApiKey(masterKey), createdAt: rotatedAt });
      await auditLog(tx).append({
        actor: { kind: 'account', id: accountId },
        action: 'master_key.rotate',
        subject: { kind: 'account', id: accountId },
        requestId,
        details: { revokedKeyId: keyId, masterKeyId: newKeyId },
      });
    }));

    return masterKey;
  },
});
