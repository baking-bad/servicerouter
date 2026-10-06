import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { formatUsd, parseUsd, Secret, ServiceRouterError, usdAmountPattern, type Clock, type IdGenerator } from '@servicerouter/common';
import type { AuditLog, Environment, OwnershipVerifier } from '@servicerouter/core';
import {
  createAccountRepository, createAuditLogRepository, createLedger, createPayoutRepository, createRoutingRepository, createTreasuryRepository,
  withTransaction, type Database, type DatabaseTransaction,
} from '@servicerouter/db';

import { ConflictError, InvalidRequestError, NotFoundError } from '../errors.js';

/** An operator's reference used before for another movement (LG-3). */
class IdempotencyConflictError extends ServiceRouterError {
  readonly code = 'idempotency_conflict';
}

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
  // The asset registry's names, for treasury transfers (TR-4)
  readonly assetNames: ReadonlySet<string>;
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

const assetAmount = {
  type: 'object',
  required: ['asset', 'amount'],
  properties: {
    asset: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' },
    amount: { type: 'string', pattern: usdAmountPattern, maxLength: 26 },
  },
  additionalProperties: false,
} as const;

const transferBodySchema = {
  type: 'object',
  required: ['reference', 'from', 'to', 'transactions'],
  properties: {
    reference: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
    from: assetAmount,
    to: assetAmount,
    // The operator's references: transaction hashes or explorer links
    transactions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 256 } },
  },
  additionalProperties: false,
} as const;

interface TransferBody {
  readonly reference: string;
  readonly from: { readonly asset: string; readonly amount: string };
  readonly to: { readonly asset: string; readonly amount: string };
  readonly transactions: readonly string[];
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
  assetNames,
  auditLog = tx => createAuditLogRepository({ db: tx, clock, ids }),
}: InternalRoutesOptions): void => {
  app.addHook('onRequest', createInternalAuth(secret));

  const callerOf = (request: FastifyRequest): string => {
    const header = request.headers[internalCallerHeader];

    return typeof header === 'string' && callerPattern.test(header) ? header : 'unknown';
  };

  const routing = createRoutingRepository({ db, clock });
  const audit = (request: FastifyRequest, action: `${string}.${string}`, subject: { kind: string; id: string }, details: Record<string, string | number | null>) =>
    withTransaction(db, tx => auditLog(tx).append({ actor: { kind: 'internal_api', id: callerOf(request) }, action, subject, requestId: request.id, details }));

  // RT-12, RT-13: the proxy registers an endpoint that answered 402, once, up to the cap per host (AR17)
  app.put<{ Body: { readonly host: string; readonly path: string } }>('/internal/v1/routed-endpoints', {
    schema: { body: {
      type: 'object', required: ['host', 'path'], additionalProperties: false,
      properties: { host: { type: 'string', maxLength: 253 }, path: { type: 'string', pattern: '^/', maxLength: 2048 } },
    } },
  }, async (request, reply) => {
    const { host, path } = request.body;
    // The host as the routing link names it: a lowercase DNS name, with a port when one was given
    const [hostname = '', port] = host.split(':');
    if (!hostPattern.test(hostname) || (port !== undefined && !/^\d{1,5}$/.test(port)))
      throw new InvalidRequestError('host must be a lowercase DNS name, with an optional port');
    const result = await routing.registerEndpoint({ host, path });
    if (result === 'created')
      await audit(request, 'routing.endpoint_register', { kind: 'routed_endpoint', id: `${host}${path}` }, { host, path });

    return reply.status(result === 'created' ? 201 : 200).send({ host, path, result });
  });

  // RT-5: an endpoint's own fee, or null for routingFeeBps
  app.put<{ Params: { readonly host: string }; Body: { readonly path: string; readonly feeBps: number | null } }>('/internal/v1/routed-endpoints/:host/fee', {
    schema: { body: {
      type: 'object', required: ['path', 'feeBps'], additionalProperties: false,
      properties: { path: { type: 'string', pattern: '^/', maxLength: 2048 }, feeBps: { type: ['integer', 'null'], minimum: 0, maximum: 10_000 } },
    } },
  }, async request => {
    const { host } = request.params;
    const { path, feeBps } = request.body;
    if (!await routing.setEndpointFee({ host, path, feeBps }))
      throw new NotFoundError('No such routed endpoint');
    await audit(request, 'routing.endpoint_fee', { kind: 'routed_endpoint', id: `${host}${path}` }, { feeBps });

    return { host, path, feeBps };
  });

  // RT-18: hosts the proxy refuses
  app.put<{ Params: { readonly host: string }; Body: { readonly reason: string } }>('/internal/v1/blocklist/:host', {
    schema: { body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } } },
  }, async request => {
    const { host } = request.params;
    if (!hostPattern.test(host))
      throw new InvalidRequestError('host must be a lowercase DNS name');
    await routing.block({ host, reason: request.body.reason });
    await audit(request, 'routing.block', { kind: 'host', id: host }, { reason: request.body.reason });

    return { host, blocked: true };
  });

  app.delete<{ Params: { readonly host: string } }>('/internal/v1/blocklist/:host', async request => {
    const { host } = request.params;
    if (!await routing.unblock(host))
      throw new NotFoundError('The host isn\'t blocked');
    await audit(request, 'routing.unblock', { kind: 'host', id: host }, {});

    return { host, blocked: false };
  });

  // PO-6, AR10: an operator approves a payout run that waits. The workers then submit it.
  app.post<{ Params: { readonly run: string } }>('/internal/v1/payouts/:run/approve', async request => {
    const { run } = request.params;
    const repository = createPayoutRepository({ db, clock, ids });
    const actor = { kind: 'internal_api', id: callerOf(request) } as const;
    const approved = await repository.approve({ id: run, by: actor.id });
    if (!approved) {
      const existing = await repository.findRun(run);
      if (!existing)
        throw new NotFoundError('No such payout run');
      throw new ConflictError(`The payout run is ${existing.status}: only a run awaiting approval can be approved`);
    }
    await withTransaction(db, tx => auditLog(tx).append({
      actor, action: 'payout.approve', subject: { kind: 'payout_run', id: run }, requestId: request.id, details: { total: approved.total.toString() },
    }));

    return { id: approved.id, status: approved.status, total: formatUsd(approved.total), approvedAt: approved.approvedAt!.toISOString(), approvedBy: approved.approvedBy };
  });

  // TR-4: an operator records a rebalancing they did, with its transactions. The ledger books it once.
  app.post<{ Body: TransferBody }>('/internal/v1/treasury/transfers', { schema: { body: transferBodySchema } }, async (request, reply) => {
    const { reference, from, to, transactions } = request.body;
    let fromAmount: bigint;
    let toAmount: bigint;
    try {
      fromAmount = parseUsd(from.amount);
      toAmount = parseUsd(to.amount);
    }
    catch {
      throw new InvalidRequestError('An amount is too large');
    }
    if (fromAmount === 0n || toAmount === 0n)
      throw new InvalidRequestError('Both amounts must be more than zero');
    if (toAmount > fromAmount)
      throw new InvalidRequestError('A transfer can\'t gain USD: what arrives is at most what left (TR-6)');
    if (from.asset === to.asset)
      throw new InvalidRequestError('A transfer moves between two different assets');
    if (!assetNames.has(from.asset) || !assetNames.has(to.asset))
      throw new InvalidRequestError('Both assets must be in the asset registry');

    const actor = { kind: 'internal_api', id: callerOf(request) } as const;
    const result = await withTransaction(db, async tx => {
      const booked = await createLedger({ db: tx, clock, ids }).treasuryTransfer({
        reference, from: { asset: from.asset, amount: fromAmount }, to: { asset: to.asset, amount: toAmount }, requestId: request.id,
      });
      if (booked.replayed) {
        // The same reference again: the same transfer is a replay, another one a conflict (LG-3)
        const stored = await createTreasuryRepository({ db: tx }).findTransfer(reference);
        if (!stored || stored.fromAsset !== from.asset || stored.toAsset !== to.asset || stored.fromAmount !== fromAmount || stored.toAmount !== toAmount)
          throw new IdempotencyConflictError('This reference was used for another transfer');
      }
      else {
        await createTreasuryRepository({ db: tx }).recordTransfer({
          reference, fromAsset: from.asset, fromAmount, toAsset: to.asset, toAmount, transactions: [...transactions], recordedBy: actor.id,
          ledgerTransactionId: booked.transactionId, createdAt: booked.createdAt,
        });
      }
      await auditLog(tx).append({
        actor, action: 'treasury.transfer', subject: { kind: 'treasury_transfer', id: reference }, requestId: request.id,
        details: { from: from.asset, fromAmount: fromAmount.toString(), to: to.asset, toAmount: toAmount.toString(), replayed: booked.replayed },
      });

      return booked;
    });

    return reply.status(result.replayed ? 200 : 201).send({
      reference, transactionId: result.transactionId, conversionCost: formatUsd(fromAmount - toAmount), replayed: result.replayed,
      createdAt: result.createdAt.toISOString(),
    });
  });

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
