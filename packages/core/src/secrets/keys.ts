import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

import type { Secret } from '@servicerouter/common';

import { SecretKeyInvalidError } from './ports.js';

export const minimumKeyBits = 3072;

/** S2-D3: the first 16 bytes of SHA-256 over the public key's SPKI DER, in base64url. */
export const deriveKeyId = (key: KeyObject): string => {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  const der = publicKey.export({ type: 'spki', format: 'der' });

  return createHash('sha256').update(der).digest().subarray(0, 16).toString('base64url');
};

const checkRsa = (key: KeyObject): void => {
  if (key.asymmetricKeyType !== 'rsa')
    throw new SecretKeyInvalidError(`The key must be an RSA key, not ${key.asymmetricKeyType ?? 'an unknown type'}`);

  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < minimumKeyBits)
    throw new SecretKeyInvalidError(`The RSA key has ${bits} bits; at least ${minimumKeyBits} are required`);
};

const isPrivateKey = (pem: string): boolean => {
  try {
    createPrivateKey({ key: pem, format: 'pem' });

    return true;
  }
  catch {
    return false;
  }
};

/** Loads the public key that seals. Refuses a private key, so the Platform API can never be handed one (SC-2, SC-4). */
export const loadPublicKey = (pem: string): KeyObject => {
  // createPublicKey would derive the public half of a private key and carry on. The header also
  // catches an encrypted private key, which can't be parsed without its passphrase.
  if (/PRIVATE KEY-----/.test(pem) || isPrivateKey(pem))
    throw new SecretKeyInvalidError('The sealer takes the public key only, and this is a private key');

  let key: KeyObject;
  try {
    key = createPublicKey({ key: pem, format: 'pem' });
  }
  catch {
    throw new SecretKeyInvalidError('The public key is not a valid PEM public key');
  }
  checkRsa(key);

  return key;
};

/** Loads a private key that opens (SC-4). */
export const loadPrivateKey = (pem: Secret): KeyObject => {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem.expose(), format: 'pem' });
  }
  catch {
    throw new SecretKeyInvalidError('The private key is not a valid, unencrypted PEM private key');
  }
  checkRsa(key);

  return key;
};
