import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '@servicerouter/common';

import { createSecretOpener, createSecretSealer, SecretKeyInvalidError } from '../../src/index.js';
import { generateRsaKeyPair, type PemKeyPair } from './keyPairs.js';

let pair: PemKeyPair;
let short: PemKeyPair;

beforeAll(async () => {
  [pair, short] = await Promise.all([generateRsaKeyPair(), generateRsaKeyPair(2048)]);
});

const thrown = (create: () => unknown): Error => {
  try {
    create();
  }
  catch (error) {
    return error as Error;
  }
  throw new Error('Expected an error');
};

const ecKeyPair = () => generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Every way to print an error, joined
const shown = (error: Error): string => [error.message, JSON.stringify(error), inspect(error, { depth: 5 })].join('\n');
const keyBody = (pem: string): string => pem.split('\n')[1]!;

describe('createSecretSealer (SC-4)', () => {
  it('accepts a 3072-bit RSA public key', () => {
    expect(createSecretSealer(pair.publicKey).keyId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it.each([
    ['a PKCS#8 private key', () => pair.privateKey, 'The sealer takes the public key only, and this is a private key'],
    ['a PKCS#1 private key', () => createPrivateKey(pair.privateKey).export({ type: 'pkcs1', format: 'pem' }) as string, 'The sealer takes the public key only, and this is a private key'],
    ['an encrypted private key', () => createPrivateKey(pair.privateKey).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pass' }) as string, 'The sealer takes the public key only, and this is a private key'],
    ['a 2048-bit key', () => short.publicKey, 'The RSA key has 2048 bits; at least 3072 are required'],
    ['an EC key', () => ecKeyPair().publicKey, 'The key must be an RSA key, not ec'],
    ['text that isn\'t a key', () => 'not a key', 'The public key is not a valid PEM public key'],
  ])('refuses %s with secret_key_invalid (SC-4)', (_name, pem, message) => {
    const text = pem();
    const error = thrown(() => createSecretSealer(text));

    expect(error).toBeInstanceOf(SecretKeyInvalidError);
    expect(error).toMatchObject({ code: 'secret_key_invalid', message });
    expect(shown(error)).not.toContain(keyBody(text) || text);
  });
});

describe('createSecretOpener (SC-4)', () => {
  it('accepts private keys in Secret', () => {
    expect(createSecretOpener([Secret.from(pair.privateKey)]).keyIds).toEqual([createSecretSealer(pair.publicKey).keyId]);
  });

  it.each([
    ['no keys', () => [], 'The opener needs at least one private key'],
    ['a public key', () => [pair.publicKey], 'The private key is not a valid, unencrypted PEM private key'],
    ['an encrypted private key', () => [createPrivateKey(pair.privateKey).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pass' }) as string], 'The private key is not a valid, unencrypted PEM private key'],
    ['a 2048-bit key', () => [short.privateKey], 'The RSA key has 2048 bits; at least 3072 are required'],
    ['an EC key', () => [ecKeyPair().privateKey], 'The key must be an RSA key, not ec'],
  ])('refuses %s with secret_key_invalid (SC-4)', (_name, pems, message) => {
    const texts = pems();
    const error = thrown(() => createSecretOpener(texts.map(text => Secret.from(text))));

    expect(error).toMatchObject({ code: 'secret_key_invalid', message });
    for (const text of texts)
      expect(shown(error)).not.toContain(keyBody(text));
  });
});
