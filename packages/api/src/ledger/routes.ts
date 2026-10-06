import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { formatUsd, type Clock, type IdGenerator } from '@servicerouter/common';
import { nextPayoutDate, ServiceForbiddenError, ServiceNotFoundError, type Payment } from '@servicerouter/core';
import { createLedger, createPaymentRepository, createServiceRepository, type Database } from '@servicerouter/db';

import { authenticatedAccount } from '../accounts/auth.js';

export interface LedgerRoutesOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  // The master key hook (PA-2)
  readonly authenticate: onRequestHookHandler;
}

const defaultPageSize = 50;
const maxPageSize = 100;

const pageQuerySchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: maxPageSize },
    after: { type: 'string', maxLength: 512 },
  },
  additionalProperties: false,
} as const;

interface PageQuery {
  readonly limit?: number;
  readonly after?: string;
}

/** A payment as its buyer sees it: what was called, the price, and where it stands. Never the seller's side. */
const toPaymentBody = (payment: Payment) => ({
  id: payment.id,
  requestId: payment.requestId ?? null,
  kind: payment.kind,
  rail: payment.rail,
  serviceId: payment.serviceId ?? null,
  routeKey: payment.routeKey ?? null,
  targetHost: payment.targetHost ?? null,
  targetPath: payment.targetPath ?? null,
  amount: formatUsd(payment.amount),
  status: payment.status,
  createdAt: payment.createdAt.toISOString(),
  updatedAt: payment.updatedAt.toISOString(),
});

/**
 * Behind the master key (PA-2): `GET /v1/balance`, `GET /v1/payments`, and
 * `GET /v1/services/{id}/earnings` (LG-10). Amounts are USD decimal strings (CK-4).
 */
export const registerLedgerRoutes = (app: FastifyInstance, { db, clock, ids, authenticate }: LedgerRoutesOptions): void => {
  const ledger = createLedger({ db, clock, ids });
  const payments = createPaymentRepository({ db, clock });
  const services = createServiceRepository({ db });

  app.register(async scope => {
    scope.addHook('onRequest', authenticate);

    scope.get('/v1/balance', async request => {
      const { available, held } = await ledger.balance(authenticatedAccount(request).accountId);

      return { available: formatUsd(available), held: formatUsd(held) };
    });

    scope.get<{ Querystring: PageQuery }>('/v1/payments', { schema: { querystring: pageQuerySchema } }, async request => {
      const { accountId } = authenticatedAccount(request);
      const page = await payments.listForBuyer({
        buyerAccountId: accountId,
        limit: request.query.limit ?? defaultPageSize,
        ...(request.query.after === undefined ? {} : { after: request.query.after }),
      });

      return { payments: page.payments.map(toPaymentBody), next: page.next ?? null };
    });

    scope.get<{ Params: { readonly id: string } }>('/v1/services/:id/earnings', async request => {
      const { accountId } = authenticatedAccount(request);
      const service = await services.find(request.params.id);
      if (!service)
        throw new ServiceNotFoundError('No such service');
      if (service.ownerAccountId !== accountId)
        throw new ServiceForbiddenError();

      const earnings = await payments.earnings(service.id);

      return {
        serviceId: service.id,
        calls: earnings.calls,
        earned: {
          total: formatUsd(earnings.earned),
          byRail: Object.fromEntries(Object.entries(earnings.earnedByRail).map(([rail, amount]) => [rail, formatUsd(amount)])),
        },
        fee: formatUsd(earnings.fee),
        paidOut: formatUsd(earnings.paidOut),
        pending: formatUsd(earnings.earned - earnings.paidOut),
        nextPayoutDate: nextPayoutDate(clock.now()),
      };
    });
  });
};
