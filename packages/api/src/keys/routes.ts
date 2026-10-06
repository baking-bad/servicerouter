import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { formatUsd, parseUsd, usdAmountPattern, type Clock, type MicroUsd } from '@servicerouter/common';
import type { PaymentKeyChanges } from '@servicerouter/core';

import { authenticatedAccount } from '../accounts/auth.js';
import { InvalidRequestError } from '../errors.js';
import type { PaymentKeyService, PaymentKeyView } from './service.js';

export interface KeyRoutesOptions {
  readonly keys: PaymentKeyService;
  // The master key hook (PA-2)
  readonly authenticate: onRequestHookHandler;
  readonly clock: Clock;
}

const maxLabelLength = 60;
const usd = { type: 'string', pattern: usdAmountPattern, maxLength: 26 } as const;
const nullable = <TSchema extends { readonly type: string }>(schema: TSchema) => ({ ...schema, type: [schema.type, 'null'] }) as const;
const label = { type: 'string', maxLength: maxLabelLength } as const;
const expiresAt = { type: 'string', format: 'date-time' } as const;

const createBodySchema = {
  type: 'object',
  properties: { label, allowance: usd, dailyBudget: usd, maxPrice: usd, expiresAt },
  additionalProperties: false,
} as const;

const updateBodySchema = {
  type: 'object',
  properties: { label: nullable(label), allowance: nullable(usd), dailyBudget: usd, maxPrice: nullable(usd), expiresAt: nullable(expiresAt) },
  additionalProperties: false,
} as const;

interface LimitsBody {
  readonly label?: string | null;
  readonly allowance?: string | null;
  readonly dailyBudget?: string;
  readonly maxPrice?: string | null;
  readonly expiresAt?: string | null;
}

interface KeyParams {
  readonly id: string;
}

// The schema checked the pattern; this checks the range, naming the field only
const amount = (field: string, value: string): MicroUsd => {
  try {
    return parseUsd(value);
  }
  catch {
    throw new InvalidRequestError(`${field} is too large`);
  }
};

/** The body's fields as changes. `null` clears an optional limit; a missing field stays as it is. */
const toChanges = (body: LimitsBody, now: Date): PaymentKeyChanges => {
  const changes: { -readonly [Field in keyof PaymentKeyChanges]: PaymentKeyChanges[Field] } = {};
  if (body.label !== undefined)
    changes.label = body.label ?? undefined;
  if (body.allowance !== undefined)
    changes.allowance = body.allowance === null ? undefined : amount('allowance', body.allowance);
  if (body.dailyBudget !== undefined)
    changes.dailyBudget = amount('dailyBudget', body.dailyBudget);
  if (body.maxPrice !== undefined)
    changes.maxPrice = body.maxPrice === null ? undefined : amount('maxPrice', body.maxPrice);
  if (body.expiresAt !== undefined) {
    const expiry = body.expiresAt === null ? undefined : new Date(body.expiresAt);
    if (expiry && expiry.getTime() <= now.getTime())
      throw new InvalidRequestError('expiresAt must be in the future');
    changes.expiresAt = expiry;
  }

  return changes;
};

const remaining = (limit: MicroUsd, spent: MicroUsd): string => formatUsd(limit > spent ? limit - spent : 0n);

/** A key as the owner sees it: limits and what's left of them, never the key or its hash (AK-3, AK-6). */
const toKeyBody = ({ key, spent }: PaymentKeyView) => ({
  id: key.id,
  label: key.label ?? null,
  allowance: key.allowance === undefined ? null : formatUsd(key.allowance),
  dailyBudget: formatUsd(key.dailyBudget),
  maxPrice: key.maxPrice === undefined ? null : formatUsd(key.maxPrice),
  expiresAt: key.expiresAt?.toISOString() ?? null,
  createdAt: key.createdAt.toISOString(),
  revokedAt: key.revokedAt?.toISOString() ?? null,
  spent: { today: formatUsd(spent.today), total: formatUsd(spent.total) },
  remaining: {
    allowance: key.allowance === undefined ? null : remaining(key.allowance, spent.total),
    dailyBudget: remaining(key.dailyBudget, spent.today),
  },
});

/**
 * Behind the master key (PA-2): `POST /v1/keys`, `GET /v1/keys`, `PATCH /v1/keys/{id}`, and
 * `DELETE /v1/keys/{id}` (AK-6). Amounts are USD decimal strings (CK-4).
 */
export const registerKeyRoutes = (app: FastifyInstance, { keys, authenticate, clock }: KeyRoutesOptions): void => {
  app.register(async scope => {
    scope.addHook('onRequest', authenticate);

    scope.post<{ Body: LimitsBody | undefined }>('/v1/keys', {
      // No body is the same as an empty one: a key with the default daily budget
      preValidation: async request => {
        request.body ??= {};
      },
      schema: { body: createBodySchema },
    }, async (request, reply) => {
      const { accountId } = authenticatedAccount(request);
      const changes = toChanges(request.body ?? {}, clock.now());
      const { view, key } = await keys.create({ accountId, requestId: request.id, limits: changes });
      const value = key.expose();
      key.destroy();
      // L-7: IDs and the limits' names, never the key
      request.log.info({ accountId, keyId: view.key.id, limits: Object.keys(changes) }, 'A payment key was created');

      return reply.status(201).header('cache-control', 'no-store').send({ ...toKeyBody(view), key: value });
    });

    scope.get('/v1/keys', async request => {
      const { accountId } = authenticatedAccount(request);

      return { keys: (await keys.list(accountId)).map(toKeyBody) };
    });

    scope.patch<{ Params: KeyParams; Body: LimitsBody }>('/v1/keys/:id', { schema: { body: updateBodySchema } }, async request => {
      const { accountId } = authenticatedAccount(request);
      const changes = toChanges(request.body, clock.now());
      const updated = await keys.update({ accountId, requestId: request.id, keyId: request.params.id, changes });
      request.log.info({ accountId, keyId: updated.key.id, changed: Object.keys(changes) }, 'A payment key was changed');

      return toKeyBody(updated);
    });

    scope.delete<{ Params: KeyParams }>('/v1/keys/:id', async request => {
      const { accountId } = authenticatedAccount(request);
      const key = await keys.revoke({ accountId, requestId: request.id, keyId: request.params.id });
      request.log.info({ accountId, keyId: key.id }, 'A payment key was revoked');

      return { id: key.id, revokedAt: key.revokedAt!.toISOString() };
    });
  });
};
