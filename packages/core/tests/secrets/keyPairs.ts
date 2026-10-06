import { generateKeyPair } from 'node:crypto';
import { promisify } from 'node:util';

export interface PemKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

const generate = promisify(generateKeyPair);

/** A fresh RSA key pair as PEM, made during the test run. */
export const generateRsaKeyPair = async (modulusLength = 3072): Promise<PemKeyPair> =>
  generate('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
