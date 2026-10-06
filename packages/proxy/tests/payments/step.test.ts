import { Registry } from '@prometheus-io/client';
import { describe, expect, it } from 'vitest';

import { createLogger, type MicroUsd } from '@servicerouter/common';
import type { Payment, RuntimeOperation } from '@servicerouter/core';
import type { Authorization, PaymentRail, PaymentRecorder } from '@servicerouter/payments';

import { createProxyMetrics } from '../../src/metrics.js';
import type { ProxyLimits } from '../../src/payments/limits.js';
import { createPaymentStep } from '../../src/payments/step.js';

// The payment step's lines when the platform fails after the upstream answered (L-3)

class LedgerWriteError extends Error {
  readonly code = '40P01';
}

/** A rail that authorizes anything, and whose finalize fails as a ledger write would. */
const failingRail = (settlesBeforeResponse: boolean): PaymentRail => ({
  name: settlesBeforeResponse ? 'x402' : 'credits',
  settlesBeforeResponse,
  detect: () => ({ rail: settlesBeforeResponse ? 'x402' : 'credits', key: { kind: 'payment', hash: 'h' } }) as never,
  challenge: async () => undefined,
  authorize: async (_credential, quote) => ({
    rail: settlesBeforeResponse ? 'x402' : 'credits', paymentId: quote.paymentId, amount: quote.priceMicroUsd, feeBps: 0, buyer: 'account:acc_1', receipt: undefined,
  }) as Authorization,
  finalize: async () => {
    throw new LedgerWriteError('The ledger write failed: deadlock detected');
  },
  abort: async () => undefined,
});

const noLimits: ProxyLimits = { unpaid: async () => undefined, paymentKey: async () => undefined, service: async () => undefined };
const operation = { price: 1_000n as MicroUsd, routeKey: 'getWeather', method: 'get', path: '/weather/{city}', docs: {} } as unknown as RuntimeOperation;

const setup = (rail: PaymentRail, recorder: Pick<PaymentRecorder, 'recordDecision'> = { recordDecision: async () => ({}) as Payment }) => {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const step = createPaymentStep({
    rails: [rail], detectors: [rail.detect], recorder, limits: noLimits, buyerHeaderValue: () => 'buyer', ids: { next: () => 'id-1' }, feeBps: 0,
    payUrl: 'https://pay.test', logger, metrics: createProxyMetrics(new Registry()),
  });

  return { step, lines };
};

const begin = async (step: ReturnType<typeof setup>['step']) => {
  const started = await step.begin({
    headers: {}, ip: '127.0.0.1', requestId: 'req-1', serviceId: 'weather', ownerAccountId: 'acc_seller', operation, path: '/weather/oslo',
  });
  if (started.kind !== 'paid')
    throw new Error('Not paid');

  return started.call;
};

describe('a ledger write that fails (L-3)', () => {
  it('logs a capture that fails at error, with the call\'s fields, the cause, and finalize_failed', async () => {
    const { step, lines } = setup(failingRail(false));
    const call = await begin(step);

    await step.finish(call, await step.decide(call, { status: 200, latencyMs: 12, upstreamRequestId: 'up-1' }));

    expect(lines.find(line => line['msg'] === 'Failed to finish a payment. The hold expiry worker finishes it.')).toMatchObject({
      level: 50, paymentId: 'pay_id-1', rail: 'credits', serviceId: 'weather', routeKey: 'getWeather', decision: 'billable', paymentStatus: 'finalize_failed',
      upstreamStatus: 200, upstreamMs: 12, upstreamRequestId: 'up-1', error: { type: 'Error', message: 'The ledger write failed: deadlock detected', code: '40P01' },
    });
  });

  it('logs a settlement whose ledger write fails at error, and rethrows it', async () => {
    const { step, lines } = setup(failingRail(true));
    const call = await begin(step);
    await step.decide(call, { status: 200, latencyMs: 3 });

    await expect(step.settleNow(call)).rejects.toBeInstanceOf(LedgerWriteError);

    expect(lines.find(line => line['msg'] === 'Paid call failed to settle')).toMatchObject({
      level: 50, rail: 'x402', paymentStatus: 'settlement_failed', error: { code: '40P01', stack: expect.stringContaining('step.test.ts') },
    });
  });

  it('logs a billing decision that can\'t be recorded at error, with the payment\'s ID', async () => {
    const { step, lines } = setup(failingRail(false), { recordDecision: async () => {
      throw new LedgerWriteError('The decision write failed');
    } });
    const call = await begin(step);

    expect(await step.decide(call, { status: 200, latencyMs: 1 })).toBe('billable');

    expect(lines.find(line => line['msg'] === 'Failed to record the billing decision')).toMatchObject({ level: 50, paymentId: 'pay_id-1', decision: 'billable', error: { code: '40P01' } });
  });
});
