#!/usr/bin/env node
// Prints a new key pair for sealing seller secrets (SC-2, SC-4), with its key ID (S2-D3). For local
// development and for operators. The Platform API gets the public key; only the proxy gets the
// private key. Never commit a private key.
//
// Usage:
//   node scripts/secrets-keygen.mjs
//
// Needs Node 24+. No dependencies.

import { createHash, generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
// The first 16 bytes of SHA-256 over the public key's SPKI DER, in base64url (S2-D3)
const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest().subarray(0, 16).toString('base64url');

process.stdout.write([
  `# Key ID: ${keyId}`,
  '',
  '# Public key: for the Platform API, which seals',
  publicKey.export({ type: 'spki', format: 'pem' }).trim(),
  '',
  '# Private key: for the proxy only, which opens. Keep it in the stack\'s secrets',
  privateKey.export({ type: 'pkcs8', format: 'pem' }).trim(),
  '',
].join('\n'));
