import type { FastifyInstance } from 'fastify';

import { formatUsd, type Clock, type MicroUsd } from '@servicerouter/common';
import { utcDay, type CreditsBalance, type KeySpend } from '@servicerouter/core';
import type { CreditsRail } from '@servicerouter/payments';

import { KeyRequiredError } from '../errors.js';
import type { ProxyLimits } from '../payments/limits.js';

export interface KeyRouteOptions {
  readonly credits: Pick<CreditsRail, 'detect' | 'authenticate'>;
  readonly limits: Pick<ProxyLimits, 'paymentKey'>;
  readonly ledger: {
    keySpend(keyIds: readonly string[], day: string): Promise<ReadonlyMap<string, KeySpend>>;
    balance(accountId: string): Promise<CreditsBalance>;
  };
  readonly clock: Clock;
}

const remaining = (limit: MicroUsd, spent: MicroUsd): string => formatUsd(limit > spent ? limit - spent : 0n);

/**
 * `GET /_/key` (AK-8): with a payment key, its limits and what's left of the allowance, of today's
 * budget, and of the balance, so an agent can check before it calls. The fields are those of
 * `GET /v1/keys` on the Platform API, plus the balance.
 */
export const registerKeyRoute = (app: FastifyInstance, { credits, limits, ledger, clock }: KeyRouteOptions): void => {
  app.get('/_/key', async (request, reply) => {
    const credential = credits.detect(request.headers);
    if (credential?.rail !== 'credits')
      throw new KeyRequiredError();
    if (credential.key.kind === 'payment')
      await limits.paymentKey(credential.key.hash);

    const key = await credits.authenticate(credential);
    const [spend, balance] = await Promise.all([ledger.keySpend([key.id], utcDay(clock.now())), ledger.balance(key.accountId)]);
    const spent = spend.get(key.id) ?? { today: 0n, total: 0n };

    return reply.header('cache-control', 'no-store').send({
      id: key.id,
      label: key.label ?? null,
      allowance: key.allowance === undefined ? null : formatUsd(key.allowance),
      dailyBudget: formatUsd(key.dailyBudget),
      maxPrice: key.maxPrice === undefined ? null : formatUsd(key.maxPrice),
      expiresAt: key.expiresAt?.toISOString() ?? null,
      createdAt: key.createdAt.toISOString(),
      spent: { today: formatUsd(spent.today), total: formatUsd(spent.total) },
      remaining: {
        allowance: key.allowance === undefined ? null : remaining(key.allowance, spent.total),
        dailyBudget: remaining(key.dailyBudget, spent.today),
        balance: formatUsd(balance.available),
      },
    });
  });
};
