import { Registry } from '@prometheus-io/client';
import { describe, expect, it } from 'vitest';

import { createLogger } from '@servicerouter/common';
import type { UnbookedRoutingLoss } from '@servicerouter/db';

import { createRoutingLossMetrics, createRoutingLosses, RoutingLossesFailedError } from '../src/routingLosses.js';

const loss = (paymentId: string, amount: bigint): UnbookedRoutingLoss => ({ paymentId, amount, asset: 'base-usdc', targetHost: 'api.target.dev', buyerStatus: 'failed' });

const setup = (losses: readonly UnbookedRoutingLoss[], answer: (paymentId: string) => { replayed: boolean } | Error) => {
  const lines: Record<string, unknown>[] = [];
  const registry = new Registry();
  const booked: string[] = [];
  const job = createRoutingLosses({
    routing: { listUnbookedLosses: async limit => losses.slice(0, limit) },
    ledger: {
      routingLoss: async ({ paymentId }) => {
        const result = answer(paymentId);
        if (result instanceof Error)
          throw result;
        booked.push(paymentId);

        return { transactionId: `tx-${paymentId}`, createdAt: new Date(), replayed: result.replayed };
      },
    },
    metrics: createRoutingLossMetrics(registry),
    logger: createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }),
  });

  return { job, lines, registry, booked };
};

describe('routing losses (RT-9, P-9)', () => {
  it('books each loss, counts it in USD, and alerts with a notice', async () => {
    const { job, lines, registry } = setup([loss('pay_1', 1_000n), loss('pay_2', 500_000n)], () => ({ replayed: false }));

    expect(await job()).toEqual({ booked: 2, failed: 0 });
    expect(await registry.metrics()).toContain('routing_losses_usd_total{asset="base-usdc"} 0.501');
    expect(lines.filter(line => line['notice'] === true).map(line => [line['paymentId'], line['amount'], line['host']]))
      .toEqual([['pay_1', '0.001', 'api.target.dev'], ['pay_2', '0.5', 'api.target.dev']]);
  });

  it('counts nothing twice when the ledger already has the loss (WK-2)', async () => {
    const { job, lines, registry } = setup([loss('pay_1', 1_000n)], () => ({ replayed: true }));

    expect(await job()).toEqual({ booked: 0, failed: 0 });
    expect(await registry.metrics()).not.toContain('routing_losses_usd_total{');
    expect(lines.filter(line => line['notice'] === true)).toEqual([]);
  });

  it('books the rest when one fails, then fails the run so the job shows stale (WK-4)', async () => {
    const { job, booked } = setup([loss('pay_1', 1_000n), loss('pay_2', 1_000n)], paymentId => paymentId === 'pay_1' ? new Error('deadlock') : { replayed: false });

    await expect(job()).rejects.toThrow(RoutingLossesFailedError);
    expect(booked).toEqual(['pay_2']);
  });
});
