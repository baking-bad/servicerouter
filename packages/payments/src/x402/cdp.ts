import { createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';

import type { Clock, Secret } from '@servicerouter/common';

// One token per request, valid for 2 minutes, as the CDP SDK makes them
const lifetimeSeconds = 120;

export interface CdpApiKey {
  // CDP_API_KEY_ID: the key's name, such as `organizations/…/apiKeys/…` or a UUID
  readonly id: Secret;
  // CDP_API_KEY_SECRET: an Ed25519 key as base64 of 64 bytes (seed, then public key), or a P-256 PEM
  readonly secret: Secret;
}

/** Signs a CDP API request: the bearer token for `<method> <host><path>`. */
export type CdpRequestSigner = (method: string, url: URL) => string;

const base64url = (value: Buffer | string): string => Buffer.from(value).toString('base64url');

const loadKey = (secret: Secret): { readonly key: KeyObject; readonly alg: 'EdDSA' | 'ES256' } => {
  const text = secret.expose().replaceAll('\\n', '\n').trim();
  if (text.includes('-----BEGIN'))
    return { key: createPrivateKey(text), alg: 'ES256' };

  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== 64)
    throw new TypeError('A CDP API key secret is an Ed25519 key in base64 (64 bytes), or an EC private key in PEM');
  const key = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: base64url(bytes.subarray(0, 32)), x: base64url(bytes.subarray(32)) },
    format: 'jwk',
  });
  bytes.fill(0);

  return { key, alg: 'EdDSA' };
};

/**
 * The CDP API's JWT (PR-6): one per request, naming its method, host, and path, signed with the API
 * key. Ed25519 keys sign EdDSA and P-256 keys ES256. The claims follow the CDP SDK's `generateJwt`.
 * The key stays in a KeyObject; only its ID appears in the token.
 */
export const createCdpRequestSigner = ({ apiKey, clock }: { readonly apiKey: CdpApiKey; readonly clock: Clock }): CdpRequestSigner => {
  const { key, alg } = loadKey(apiKey.secret);
  const keyId = apiKey.id.expose();

  return (method, url) => {
    const now = Math.floor(clock.now().getTime() / 1_000);
    const header = { alg, kid: keyId, typ: 'JWT', nonce: randomBytes(16).toString('hex') };
    const claims = { sub: keyId, iss: 'cdp', uris: [`${method.toUpperCase()} ${url.host}${url.pathname}`], iat: now, nbf: now, exp: now + lifetimeSeconds };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signature = alg === 'EdDSA'
      ? sign(null, Buffer.from(signingInput), key)
      : sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });

    return `${signingInput}.${base64url(signature)}`;
  };
};
