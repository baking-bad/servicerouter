import { generateKeyPair } from 'node:crypto';
import { promisify } from 'node:util';

import { Secret } from '@servicerouter/common';
import { createSecretOpener, createSecretSealer, type SecretOpener, type SecretSealer } from '@servicerouter/core';

export interface TestSecretKeys {
  // PEM, as SECRETS_PUBLIC_KEY holds it
  readonly publicKey: string;
  // PEM, as SECRETS_PRIVATE_KEYS holds it
  readonly privateKey: string;
  readonly sealer: SecretSealer;
  readonly opener: SecretOpener;
}

const generate = promisify(generateKeyPair);
let pair: Promise<{ readonly publicKey: string; readonly privateKey: string }> | undefined;

/**
 * An RSA key pair for sealing seller secrets (SC-2), made during the test run: 3072 bits, the
 * smallest the sealer takes. One pair per test file, since generating one takes a moment.
 */
export const createTestSecretKeys = async (): Promise<TestSecretKeys> => {
  pair ??= generate('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const { publicKey, privateKey } = await pair;

  return {
    publicKey,
    privateKey,
    sealer: createSecretSealer(publicKey),
    opener: createSecretOpener([Secret.from(privateKey)]),
  };
};
