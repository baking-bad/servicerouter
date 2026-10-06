import { describe, expect, it } from 'vitest';

import { Secret } from '@servicerouter/common';
import { hashApiKey } from '@servicerouter/core';

import { createCreditsDetector, detectCredential, detectMpp, detectX402, MultiplePaymentMethodsError } from '../src/index.js';

const keyPrefixes = { master: 'srm_test_', payment: 'sr_test_' };
const paymentKey = `sr_test_${'a'.repeat(43)}`;
const masterKey = `srm_test_${'b'.repeat(43)}`;
const detectors = [createCreditsDetector(keyPrefixes), detectX402, detectMpp];

describe('credential detection (PR-1)', () => {
  it('finds a payment key in Authorization: Bearer, and keeps only its hash', () => {
    const credential = detectCredential(detectors, { authorization: `Bearer ${paymentKey}` });

    expect(credential).toEqual({ rail: 'credits', key: { kind: 'payment', hash: hashApiKey(Secret.from(paymentKey)) } });
    expect(JSON.stringify(credential)).not.toContain(paymentKey);
  });

  it.each([
    ['a master key, by its prefix (AK-4)', `Bearer ${masterKey}`, { kind: 'master' }],
    ['a payment key that is malformed', 'Bearer sr_test_short', { kind: 'invalid' }],
    ['a bearer token that is no key at all', 'Bearer opaque-token', { kind: 'invalid' }],
  ])('counts %s as a credits credential', (_case, authorization, key) => {
    expect(detectCredential(detectors, { authorization })).toEqual({ rail: 'credits', key });
  });

  it.each([
    ['PAYMENT-SIGNATURE (x402 v2)', { 'payment-signature': 'eyJ4NDAyVmVyc2lvbiI6Mn0' }, { rail: 'x402', version: 2, value: 'eyJ4NDAyVmVyc2lvbiI6Mn0' }],
    ['X-PAYMENT (x402 v1)', { 'x-payment': 'eyJ4NDAyVmVyc2lvbiI6MX0' }, { rail: 'x402', version: 1, value: 'eyJ4NDAyVmVyc2lvbiI6MX0' }],
    ['both x402 headers, one payment, v2 first', { 'payment-signature': 'v2', 'x-payment': 'v1' }, { rail: 'x402', version: 2, value: 'v2' }],
  ])('finds %s, keeping the header in a Secret', (_case, headers, expected) => {
    const credential = detectCredential(detectors, headers);

    expect(credential?.rail === 'x402' && { rail: credential.rail, version: credential.version, value: credential.header.expose() }).toEqual(expected);
    expect(JSON.stringify(credential)).not.toContain(expected.value);
  });

  it('finds Authorization: Payment (MPP)', () => {
    expect(detectCredential(detectors, { authorization: 'Payment id="abc", method="tempo"' })).toEqual({ rail: 'mpp' });
  });

  it.each([
    ['no headers', {}],
    ['another Authorization scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['empty payment headers', { 'payment-signature': '', 'x-payment': '  ' }],
  ])('finds none with %s', (_case, headers) => {
    expect(detectCredential(detectors, headers)).toBeUndefined();
  });

  it.each([
    ['a payment key and x402', { authorization: `Bearer ${paymentKey}`, 'payment-signature': 'v2' }],
    ['a master key and x402', { authorization: `Bearer ${masterKey}`, 'x-payment': 'v1' }],
    ['MPP and x402', { authorization: 'Payment id="abc"', 'payment-signature': 'v2' }],
  ])('refuses two credentials, %s, with multiple_payment_methods', (_case, headers) => {
    expect(() => detectCredential(detectors, headers)).toThrow(MultiplePaymentMethodsError);
  });
});
