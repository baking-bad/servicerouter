import { describe, expect, it } from 'vitest';

import {
  atomicToUsd, formatUsd, InexactAmountError, InvalidAmountError, isUsdAmount, maxMicroUsd, parseUsd, usdToAtomic,
} from '../src/index.js';

describe('parseUsd (CK-4)', () => {
  it.each([
    ['0', 0n],
    ['0.000001', 1n],
    ['0.001', 1_000n],
    ['1', 1_000_000n],
    ['1.5', 1_500_000n],
    ['12.345678', 12_345_678n],
    ['9223372036854.775807', maxMicroUsd],
  ])('parses %s', (value, expected) => {
    expect(parseUsd(value)).toBe(expected);
    expect(isUsdAmount(value)).toBe(true);
  });

  it.each([
    ['too many decimals', '0.0000001'],
    ['negative', '-1'],
    ['plus sign', '+1'],
    ['exponent', '1e3'],
    ['leading zero', '01'],
    ['bare dot', '1.'],
    ['leading dot', '.5'],
    ['whitespace', ' 1'],
    ['comma', '1,5'],
    ['empty', ''],
    ['hex', '0x10'],
    ['infinity', 'Infinity'],
  ])('rejects %s', (_name, value) => {
    expect(() => parseUsd(value)).toThrow(InvalidAmountError);
    expect(isUsdAmount(value)).toBe(false);
  });

  it('rejects values that overflow a Postgres bigint', () => {
    expect(() => parseUsd('9223372036854.775808')).toThrow('too large');
    expect(() => parseUsd('9'.repeat(100))).toThrow(InvalidAmountError);
  });
});

describe('formatUsd', () => {
  it.each([
    [0n, '0'],
    [1n, '0.000001'],
    [1_000n, '0.001'],
    [1_000_000n, '1'],
    [1_500_000n, '1.5'],
    [-2_500n, '-0.0025'],
    [maxMicroUsd, '9223372036854.775807'],
  ])('formats %s as %s', (amount, expected) => {
    expect(formatUsd(amount)).toBe(expected);
  });

  it('round-trips with parseUsd', () => {
    for (const value of ['0', '0.000001', '0.1', '42', '1234.56789'])
      expect(formatUsd(parseUsd(value))).toBe(value);
  });
});

describe('usdToAtomic and atomicToUsd', () => {
  it('converts exactly when the asset has at least 6 decimals', () => {
    expect(usdToAtomic(1_000n, { decimals: 6 })).toBe(1_000n);
    expect(usdToAtomic(1n, { decimals: 18 })).toBe(1_000_000_000_000n);
    expect(atomicToUsd(1_000_000n, { decimals: 6 })).toBe(1_000_000n);
    expect(atomicToUsd(10n ** 18n, { decimals: 18 })).toBe(1_000_000n);
  });

  it('requires a rounding mode when the conversion is not exact', () => {
    expect(() => usdToAtomic(1_001n, { decimals: 2 })).toThrow(InexactAmountError);
    expect(() => atomicToUsd(1n, { decimals: 18 })).toThrow(InexactAmountError);
  });

  it('rounds only as the caller asks', () => {
    expect(usdToAtomic(1_001n, { decimals: 2, rounding: 'floor' })).toBe(0n);
    expect(usdToAtomic(1_001n, { decimals: 2, rounding: 'ceil' })).toBe(1n);
    expect(usdToAtomic(10_000n, { decimals: 2 })).toBe(1n);
    expect(usdToAtomic(-1_001n, { decimals: 2, rounding: 'floor' })).toBe(-1n);
    expect(usdToAtomic(-1_001n, { decimals: 2, rounding: 'ceil' })).toBe(0n);
    expect(atomicToUsd(1n, { decimals: 18, rounding: 'ceil' })).toBe(1n);
    expect(atomicToUsd(1n, { decimals: 18, rounding: 'floor' })).toBe(0n);
  });

  it.each([-1, 1.5, 37, Number.NaN])('rejects %s decimals', decimals => {
    expect(() => usdToAtomic(1n, { decimals })).toThrow(InvalidAmountError);
  });
});
