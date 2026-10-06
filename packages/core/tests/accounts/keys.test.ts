import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { Secret } from '@servicerouter/common';

import {
  encodeBase62, generateApiKey, hashApiKey, isWellFormedKey, keyKindOf, type KeyPrefixes, type RandomSource,
} from '../../src/index.js';

const prefixes: KeyPrefixes = { master: 'srm_test_', payment: 'sr_test_' };

// Hands out the given bytes, so a test knows the key in advance
const fixedRandom = (bytes: Uint8Array): RandomSource => ({ bytes: () => Uint8Array.from(bytes) });
const counting = Uint8Array.from({ length: 32 }, (_, index) => index);

describe('generateApiKey (AK-3)', () => {
  it('is the prefix from platform config, then 32 random bytes in 43 base62 characters', () => {
    const master = generateApiKey('master', prefixes).expose();
    const payment = generateApiKey('payment', prefixes).expose();

    expect(master).toMatch(/^srm_test_[0-9A-Za-z]{43}$/);
    expect(payment).toMatch(/^sr_test_[0-9A-Za-z]{43}$/);
  });

  it('encodes the bytes from the random source', () => {
    const key = generateApiKey('master', prefixes, fixedRandom(counting));

    expect(key.expose()).toBe('srm_test_003aUlTJC7tjlCTQj2uNU3MFagCXG9LRKRcwGkBIDlf');
  });

  it('differs every time with the default random source', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey('master', prefixes).expose()));

    expect(keys.size).toBe(100);
  });

  it('returns a Secret that prints only the redaction marker (CK-1)', () => {
    const key = generateApiKey('master', prefixes);

    expect(key).toBeInstanceOf(Secret);
    expect(`${String(key)} ${JSON.stringify({ key })} ${inspect(key)}`).not.toContain('srm_test_');
  });

  it('refuses a random source that returns the wrong number of bytes', () => {
    expect(() => generateApiKey('master', prefixes, fixedRandom(new Uint8Array(16)))).toThrow('returned 16 bytes instead of 32');
  });
});

describe('encodeBase62', () => {
  it.each([
    ['zero', new Uint8Array(32), '0'.repeat(43)],
    ['one', Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0), `${'0'.repeat(42)}1`],
    ['the largest value', new Uint8Array(32).fill(0xff), 'yhjskwdA6OZ1AL1YmHWZWm8LLG7HjnuCA2j5rOw8Xp1'],
  ])('encodes %s at a fixed width', (_case, bytes, expected) => {
    expect(encodeBase62(bytes, 43)).toBe(expected);
  });
});

describe('hashApiKey (AK-3)', () => {
  it('is the SHA-256 of the whole key, prefix included, in hex', () => {
    const key = Secret.from('srm_test_003aUlTJC7tjlCTQj2uNU3MFagCXG9LRKRcwGkBIDlf');

    expect(hashApiKey(key)).toBe('59cec963b5b1ccd43027e8237cee93970840ba1a462e3eb7e9a8cdb8c258a906');
  });

  it('differs for the same body under another prefix', () => {
    const body = '003aUlTJC7tjlCTQj2uNU3MFagCXG9LRKRcwGkBIDlf';

    expect(hashApiKey(Secret.from(`srm_test_${body}`))).not.toBe(hashApiKey(Secret.from(`sr_test_${body}`)));
  });
});

describe('key kind from the prefix (AK-4)', () => {
  it('tells the kind from the prefix alone', () => {
    expect(keyKindOf('srm_test_anything', prefixes)).toBe('master');
    expect(keyKindOf('sr_test_anything', prefixes)).toBe('payment');
    expect(keyKindOf('srm_live_anything', prefixes)).toBeUndefined();
    expect(keyKindOf('sk-anything', prefixes)).toBeUndefined();
  });

  it.each([
    ['a generated master key', generateApiKey('master', prefixes).expose(), true],
    ['a short body', 'srm_test_abc', false],
    ['a long body', `srm_test_${'a'.repeat(44)}`, false],
    ['a body with -', `srm_test_${'a'.repeat(42)}-`, false],
    ['a payment key', generateApiKey('payment', prefixes).expose(), false],
  ])('checks the shape of %s', (_case, value, expected) => {
    expect(isWellFormedKey(value, 'master', prefixes)).toBe(expected);
  });
});
