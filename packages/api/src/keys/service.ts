import type { Clock, IdGenerator, Logger, MicroUsd, RequestId, Secret } from '@servicerouter/common';
import {
  generateApiKey, hashApiKey, utcDay, type AuditLog, type InvalidationBus, type JsonObject, type KeyPrefixes, type KeySpend, type PaymentKey,
  type PaymentKeyChanges, type RandomSource,
} from '@servicerouter/core';
import {
  createAuditLogRepository, createLedger, createPaymentKeyRepository, withTransaction, type Database, type DatabaseTransaction,
} from '@servicerouter/db';

import { keyIdPrefix } from '../accounts/service.js';
import { NotFoundError } from '../errors.js';
import { createPublisher } from '../invalidation.js';

export interface PaymentKeyServiceOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: RandomSource;
  readonly keyPrefixes: KeyPrefixes;
  // AR4: a new key's daily budget, from platform config
  readonly defaultDailyBudget: MicroUsd;
  readonly invalidation: Pick<InvalidationBus, 'publish'>;
  readonly logger: Logger;
  // The audit log inside a change's transaction. Default: the audit_log repository on it.
  readonly auditLog?: (tx: DatabaseTransaction) => AuditLog;
}

export interface NewPaymentKeyInput {
  readonly label?: string;
  readonly allowance?: MicroUsd;
  readonly dailyBudget?: MicroUsd;
  readonly maxPrice?: MicroUsd;
  readonly expiresAt?: Date;
}

/** A payment key with what it has spent: today, by the UTC day, and in total. */
export interface PaymentKeyView {
  readonly key: PaymentKey;
  readonly spent: KeySpend;
}

interface Change {
  readonly accountId: string;
  readonly requestId: RequestId;
}

export interface PaymentKeyService {
  /** Creates a payment key and returns it once (AK-3, AK-6). */
  create(input: Change & { readonly limits: NewPaymentKeyInput }): Promise<{ readonly view: PaymentKeyView; readonly key: Secret }>;
  list(accountId: string): Promise<readonly PaymentKeyView[]>;
  /** Changes an active key's limits or label. Throws NotFoundError for another account's key or a revoked one. */
  update(input: Change & { readonly keyId: string; readonly changes: PaymentKeyChanges }): Promise<PaymentKeyView>;
  /** Revokes an active key at once (AK-9). Throws NotFoundError for another account's key or a revoked one. */
  revoke(input: Change & { readonly keyId: string }): Promise<PaymentKey>;
}

const amountOrNull = (amount: MicroUsd | undefined): string | null => amount === undefined ? null : amount.toString();

// What the audit log records of a key's limits: amounts in micro-USD, never the key (AK-16)
const describeChanges = (changes: PaymentKeyChanges): JsonObject => Object.fromEntries(Object.entries(changes).map(([field, value]) => [
  field,
  value === undefined ? null : value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? value.toString() : value,
]));

const notFound = (): NotFoundError => new NotFoundError('No such payment key, or it is revoked');

/**
 * Payment keys (AK-6, AK-7). Every change writes the audit log in its own transaction (AK-16), and
 * publishes `{ kind: 'key' }` after the commit, so the proxy's key cache drops it at once (AK-9).
 */
export const createPaymentKeyService = ({
  db,
  clock,
  ids,
  random,
  keyPrefixes,
  defaultDailyBudget,
  invalidation,
  logger,
  auditLog = tx => createAuditLogRepository({ db: tx, clock, ids }),
}: PaymentKeyServiceOptions): PaymentKeyService => {
  const keys = createPaymentKeyRepository({ db });
  const ledger = createLedger({ db, clock, ids });
  const publish = createPublisher({ invalidation, logger });
  const audit = (tx: DatabaseTransaction, { accountId, requestId }: Change, action: `payment_key.${string}`, details: JsonObject) =>
    auditLog(tx).append({ actor: { kind: 'account', id: accountId }, action, subject: { kind: 'api_key', id: String(details['keyId']) }, requestId, details });

  const withSpend = async (list: readonly PaymentKey[]): Promise<PaymentKeyView[]> => {
    const spend = await ledger.keySpend(list.map(key => key.id), utcDay(clock.now()));

    return list.map(key => ({ key, spent: spend.get(key.id) ?? { today: 0n, total: 0n } }));
  };

  return {
    create: async ({ accountId, requestId, limits }) => {
      const id = `${keyIdPrefix}${ids.next()}`;
      const secret = generateApiKey('payment', keyPrefixes, random);
      try {
        const key = await withTransaction(db, async tx => {
          const created = await createPaymentKeyRepository({ db: tx }).insert({
            id,
            accountId,
            keyHash: hashApiKey(secret),
            label: limits.label,
            createdAt: clock.now(),
            allowance: limits.allowance,
            dailyBudget: limits.dailyBudget ?? defaultDailyBudget,
            maxPrice: limits.maxPrice,
            expiresAt: limits.expiresAt,
          });
          await audit(tx, { accountId, requestId }, 'payment_key.create', {
            keyId: id,
            label: created.label ?? null,
            allowance: amountOrNull(created.allowance),
            dailyBudget: created.dailyBudget.toString(),
            maxPrice: amountOrNull(created.maxPrice),
            expiresAt: created.expiresAt?.toISOString() ?? null,
          });

          return created;
        });
        await publish({ kind: 'key', id });

        return { view: { key, spent: { today: 0n, total: 0n } }, key: secret };
      }
      catch (error) {
        // A key that never reaches the client is wiped at once
        secret.destroy();
        throw error;
      }
    },
    list: async accountId => withSpend(await keys.list(accountId)),
    update: async ({ accountId, requestId, keyId, changes }) => {
      const key = await withTransaction(db, async tx => {
        const updated = await createPaymentKeyRepository({ db: tx }).update({ id: keyId, accountId, changes });
        if (!updated)
          throw notFound();
        await audit(tx, { accountId, requestId }, 'payment_key.update', { keyId, changes: describeChanges(changes) });

        return updated;
      });
      await publish({ kind: 'key', id: keyId });

      return (await withSpend([key]))[0]!;
    },
    revoke: async ({ accountId, requestId, keyId }) => {
      const key = await withTransaction(db, async tx => {
        const revoked = await createPaymentKeyRepository({ db: tx }).revoke({ id: keyId, accountId, revokedAt: clock.now() });
        if (!revoked)
          throw notFound();
        await audit(tx, { accountId, requestId }, 'payment_key.revoke', { keyId });

        return revoked;
      });
      await publish({ kind: 'key', id: keyId });

      return key;
    },
  };
};
