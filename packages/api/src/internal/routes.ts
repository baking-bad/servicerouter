import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { formatUsd, parseUsd, Secret, ServiceRouterError, usdAmountPattern, type Clock, type IdGenerator } from '@servicerouter/common';
import type { AuditLog, Environment, OwnershipVerifier } from '@servicerouter/core';
import { createAccountRepository, createAuditLogRepository, createLedger, withTransaction, type Database, type DatabaseTransaction } from '@servicerouter/db';

import { InvalidRequestError, NotFoundError } from '../errors.js';

// The shared secret every internal call carries (PA-4)
export const internalSecretHeader = 'x-internal-secret';
// Which app or operator calls, for the audit log. Optional.
export const internalCallerHeader = 'x-internal-caller';

const callerPattern = /^[a-z][a-z0-9-]{0,31}$/;

export interface InternalRoutesOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  // INTERNAL_API_SECRET. Without it, every internal call is refused.
  readonly secret: Secret | undefined;
  // Marks hosts verified for OV-9
  readonly verifier: Pick<OwnershipVerifier, 'markHostVerified'>;
  // OV-9's action exists in staging only
  readonly environment: Environment;
  // The audit log inside a call's transaction. Default: the audit_log repository on it.
  readonly auditLog?: (tx: DatabaseTransaction) => AuditLog;
}

const creditBodySchema = {
  type: 'object',
  required: ['amount', 'reference'],
  properties: {
    amount: { type: 'string', pattern: usdAmountPattern, maxLength: 26 },
    // The idempotency key: an operator's ticket or transfer ID
    reference: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
  },
  additionalProperties: false,
} as const;

interface CreditBody {
  readonly amount: string;
  readonly reference: string;
}

const markVerifiedBodySchema = {
  type: 'object',
  required: ['accountId'],
  properties: { accountId: { type: 'string', minLength: 1, maxLength: 256 } },
  additionalProperties: false,
} as const;

// A lowercase DNS name, as `new URL(…).hostname` gives it
const hostPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** An internal call without the right shared secret (PA-4). */
class InternalUnauthorizedError extends ServiceRouterError {
  readonly code = 'unauthorized';

  constructor() {
    super(`The internal API needs the ${internalSecretHeader} header`);
  }
}

/**
 * The `onRequest` hook of the internal listener (PA-4): the shared secret, compared with
 * `Secret.equals`. A missing or wrong one is `401 unauthorized`.
 */
export const createInternalAuth = (secret: Secret | undefined) => async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const header = request.headers[internalSecretHeader];
  const given = typeof header === 'string' && header !== '' ? Secret.from(header) : undefined;
  try {
    if (secret && given?.equals(secret))
      return;
  }
  finally {
    given?.destroy();
  }
  request.log.warn('An internal call without the right shared secret was refused');
  reply.header('www-authenticate', 'Bearer');
  throw new InternalUnauthorizedError();
};

/**
 * The internal API (PA-4). `POST /internal/v1/accounts/{id}/credits` credits an account until deposits
 * exist (step 9), idempotent by `reference`. Every call writes the audit log, in its transaction.
 */
export const registerInternalRoutes = (app: FastifyInstance, {
  db,
  clock,
  ids,
  secret,
  verifier,
  environment,
  auditLog = tx => createAuditLogRepository({ db: tx, clock, ids }),
}: InternalRoutesOptions): void => {
  app.addHook('onRequest', createInternalAuth(secret));

  const callerOf = (request: FastifyRequest): string => {
    const header = request.headers[internalCallerHeader];

    return typeof header === 'string' && callerPattern.test(header) ? header : 'unknown';
  };

  // OV-9: staging only, for demos with sellers who haven't published the file yet. Production can't
  // enable it: the route doesn't exist there.
  if (environment === 'staging') {
    app.post<{ Params: { readonly host: string }; Body: { readonly accountId: string } }>('/internal/v1/hosts/:host/verify', {
      schema: { body: markVerifiedBodySchema },
    }, async request => {
      const { host } = request.params;
      if (!hostPattern.test(host))
        throw new InvalidRequestError('host must be a lowercase DNS name');

      const { accountId } = request.body;
      if (!await createAccountRepository({ db }).findById(accountId))
        throw new NotFoundError('No such account');

      const actor = { kind: 'internal_api', id: callerOf(request) } as const;
      const recorded = await verifier.markHostVerified({ accountId, host, actor, requestId: request.id });
      await withTransaction(db, tx => auditLog(tx).append({
        actor, action: 'ownership.mark_verified', subject: { kind: 'upstream_host', id: host }, requestId: request.id, details: { accountId },
      }));

      return {
        host,
        accountId,
        state: 'verified',
        services: recorded.serviceChanges.map(change => ({ id: change.serviceId, state: change.to })),
      };
    });
  }

  app.post<{ Params: { readonly id: string }; Body: CreditBody }>('/internal/v1/accounts/:id/credits', {
    schema: { body: creditBodySchema },
  }, async (request, reply) => {
    const accountId = request.params.id;
    let amount: bigint;
    try {
      amount = parseUsd(request.body.amount);
    }
    catch {
      throw new InvalidRequestError('amount is too large');
    }
    if (amount === 0n)
      throw new InvalidRequestError('amount must be more than zero');
    if (!await createAccountRepository({ db }).findById(accountId))
      throw new NotFoundError('No such account');

    const caller = callerOf(request);
    const { reference } = request.body;
    const result = await withTransaction(db, async tx => {
      const credited = await createLedger({ db: tx, clock, ids }).credit({ accountId, amount, reference, requestId: request.id });
      await auditLog(tx).append({
        actor: { kind: 'internal_api', id: caller },
        action: 'ledger.credit',
        subject: { kind: 'account', id: accountId },
        requestId: request.id,
        details: { amount: amount.toString(), reference, transactionId: credited.transactionId, replayed: credited.replayed },
      });

      return credited;
    });

    return reply.status(result.replayed ? 200 : 201).send({
      transactionId: result.transactionId,
      accountId,
      amount: formatUsd(amount),
      reference,
      replayed: result.replayed,
      createdAt: result.createdAt.toISOString(),
    });
  });
};
