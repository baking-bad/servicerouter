import { describe, expect, it } from 'vitest';

import { billingDecision, buildPaymentRequired, type Quote } from '../src/index.js';

const quote = { paymentId: 'pay_1', priceMicroUsd: 1_000n } as Quote;

describe('the combined 402 (PR-2)', () => {
  it('assembles every rail\'s headers and body fields into one response that is never cached', () => {
    const rails = [
      { challenge: () => ({ body: { credits: { price: '0.001' } } }) },
      { challenge: () => undefined },
      { challenge: () => ({ headers: { 'payment-required': 'eyJ4NDAy' }, body: { x402Version: 2, accepts: [] } }) },
    ];

    expect(buildPaymentRequired(rails, quote)).toEqual({
      status: 402,
      headers: { 'payment-required': 'eyJ4NDAy', 'cache-control': 'no-store' },
      body: { credits: { price: '0.001' }, x402Version: 2, accepts: [] },
    });
  });

  it('keeps no-store even when a rail sets its own cache control', () => {
    const rails = [{ challenge: () => ({ headers: { 'cache-control': 'public, max-age=60' } }) }];

    expect(buildPaymentRequired(rails, quote).headers['cache-control']).toBe('no-store');
  });
});

describe('the billing decision (PX-11)', () => {
  it.each([
    [200, 'billable'],
    [201, 'billable'],
    [299, 'billable'],
    [199, 'not_billable'],
    [302, 'not_billable'],
    [404, 'not_billable'],
    [500, 'not_billable'],
    [undefined, 'not_billable'],
  ])('decides %s is %s', (status, decision) => {
    expect(billingDecision(status)).toBe(decision);
  });
});
