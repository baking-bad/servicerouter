import { describe, expect, it } from 'vitest';

import { compactCount, latency, percent } from '../src/format';
import { displayUsd, formatMicroUsd, parseUsd } from '../src/money';

describe('USD amounts (CK-4)', () => {
  it('parses decimal strings to micro-USD, and refuses anything else', () => {
    expect(parseUsd('0.001')).toBe(1_000n);
    expect(parseUsd('12.5')).toBe(12_500_000n);
    expect(parseUsd('0.0000001')).toBeUndefined();
    expect(parseUsd('1e3')).toBeUndefined();
    expect(parseUsd('-1')).toBeUndefined();
  });

  it('shows prices for people', () => {
    expect(formatMicroUsd(1_000n)).toBe('0.001');
    expect(displayUsd('0.0005')).toBe('$0.0005');
    expect(displayUsd('25')).toBe('$25.00');
    expect(displayUsd('1234.5')).toBe('$1,234.50');
  });

  it('shows counts, percentages, and latencies compactly', () => {
    expect(compactCount(906_300)).toBe('906.3K');
    expect(percent(0.9981)).toBe('99.8%');
    expect(latency(84)).toBe('84 ms');
    expect(latency(6_200)).toBe('6.2 s');
  });
});
