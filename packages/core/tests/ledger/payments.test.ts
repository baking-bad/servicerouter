import { fixtureDay, fixtureTime } from '@servicerouter/testing';

import { describe, expect, it } from 'vitest';

import { canChangePaymentStatus, nextPayoutDate, paymentStatuses, splitFee, statusesBefore, utcDay } from '../../src/index.js';

describe('the fee split (LG-4, AR6)', () => {
  it.each([
    [1_000n, 250, 25n, 975n],
    [7n, 250, 0n, 7n],
    [999n, 1_000, 99n, 900n],
    [1_000_000n, 0, 0n, 1_000_000n],
    [1_000_000n, 10_000, 1_000_000n, 0n],
  ])('splits %i micro-USD at %i bps into a fee of %i and %i for the seller, rounding the fee down', (amount, feeBps, fee, sellerAmount) => {
    expect(splitFee(amount, feeBps)).toEqual({ fee, sellerAmount });
  });

  it.each([-1, 10_001, 2.5])('refuses %d bps', feeBps => {
    expect(() => splitFee(1_000n, feeBps)).toThrow(RangeError);
  });
});

describe('the flat fee per payment (P-2, LG-4)', () => {
  it.each([
    ['a $0.001 call with a $0.0005 flat fee: half each', 1_000n, 0, 500n, 500n, 500n],
    ['a $0.0003 call: the fee is capped at the amount, and the seller gets 0', 300n, 0, 500n, 300n, 0n],
    ['a call of exactly the flat fee', 500n, 0, 500n, 500n, 0n],
    ['a $0.01 call at 1000 bps plus the flat fee', 10_000n, 1_000, 500n, 1_500n, 8_500n],
    ['a $0.001 call at 10000 bps: never more than the amount', 1_000n, 10_000, 500n, 1_000n, 0n],
    ['a free call', 0n, 0, 500n, 0n, 0n],
    ['no flat fee: feeBps alone', 1_000n, 250, 0n, 25n, 975n],
  ])('splits %s', (_case, amount, feeBps, feePerPayment, fee, sellerAmount) => {
    const split = splitFee(amount, feeBps, feePerPayment);

    expect(split).toEqual({ fee, sellerAmount });
    expect(split.fee + split.sellerAmount).toBe(amount);
    expect(split.sellerAmount >= 0n).toBe(true);
  });

  it('refuses a negative flat fee', () => {
    expect(() => splitFee(1_000n, 0, -1n)).toThrow(RangeError);
  });
});

describe('payment status changes (LG-8)', () => {
  it.each([
    ['held', 'captured'],
    ['held', 'released'],
    ['verified', 'settling'],
    ['verified', 'settled'],
    ['verified', 'cancelled'],
    ['verified', 'failed'],
    ['settling', 'settled'],
    ['settling', 'failed'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(canChangePaymentStatus(from, to)).toBe(true);
  });

  it('allows nothing else, and nothing out of a final status', () => {
    const allowed = paymentStatuses.flatMap(from => paymentStatuses.filter(to => canChangePaymentStatus(from, to)).map(to => `${from}→${to}`));

    expect(allowed).toHaveLength(8);
    for (const final of ['captured', 'settled', 'released', 'cancelled', 'failed'] as const)
      expect(paymentStatuses.filter(to => canChangePaymentStatus(final, to))).toEqual([]);
    expect(statusesBefore('held')).toEqual([]);
    expect(statusesBefore('settled')).toEqual(['verified', 'settling']);
  });
});

describe('dates (AR5, LG-10)', () => {
  it('counts a daily budget by the UTC day', () => {
    expect(utcDay(new Date(fixtureTime(0, 5, 23, 59, 59, 999)))).toBe(fixtureDay(0, 5));
    expect(utcDay(new Date(fixtureTime(0, 6, 0, 0, 0, 0)))).toBe(fixtureDay(0, 6));
  });

  it.each([
    [fixtureTime(0, 5, 12, 0, 0, 0), fixtureDay(1, 1)],
    [fixtureTime(2, 31, 23, 59, 59, 0), fixtureDay(3, 1)],
    [fixtureTime(-9, 1, 0, 0, 0, 0), fixtureDay(-8, 1)],
  ])('puts the next payout after %s on %s', (now, expected) => {
    expect(nextPayoutDate(new Date(now))).toBe(expected);
  });
});
