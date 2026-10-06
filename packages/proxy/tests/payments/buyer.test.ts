import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Secret } from '@servicerouter/common';

import { createBuyerHeaderValue } from '../../src/payments/buyer.js';

const keyText = 'buyer-header-key-0123456789abcdef-xyz';

describe('the buyer header (PX-15)', () => {
  it('is HMAC-SHA256 of the buyer and the service ID under the platform key, in base64url', () => {
    const value = createBuyerHeaderValue(Secret.from(keyText))('account:acc_1', 'weather');

    expect(value).toBe(createHmac('sha256', keyText).update('account:acc_1\nweather').digest('base64url'));
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is stable per buyer and service, and differs across services, buyers, and keys', () => {
    const header = createBuyerHeaderValue(Secret.from(keyText));
    const other = createBuyerHeaderValue(Secret.from(`${keyText}-other`));

    expect(header('account:acc_1', 'weather')).toBe(header('account:acc_1', 'weather'));
    expect(new Set([
      header('account:acc_1', 'weather'),
      header('account:acc_1', 'maps'),
      header('account:acc_2', 'weather'),
      other('account:acc_1', 'weather'),
    ]).size).toBe(4);
  });

  it('never contains the buyer or the service ID', () => {
    const value = createBuyerHeaderValue(Secret.from(keyText))('account:acc_1', 'weather');

    expect(value).not.toContain('acc_1');
    expect(value).not.toContain('weather');
  });
});
