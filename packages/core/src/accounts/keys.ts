import { createHash, randomBytes } from 'node:crypto';

import { Secret } from '@servicerouter/common';

export const keyKinds = ['master', 'payment'] as const;
export type KeyKind = typeof keyKinds[number];

/** The prefix of each kind of key, from platform config (PC-7). Neither starts with the other. */
export type KeyPrefixes = Readonly<Record<KeyKind, string>>;

/** Port: cryptographic randomness, so tests can make keys they know in advance. */
export interface RandomSource {
  bytes(size: number): Uint8Array;
}

export const cryptoRandomSource: RandomSource = {
  bytes: size => randomBytes(size),
};

// AK-3: 32 random bytes after the prefix
export const keyBytes = 32;
// Base62 is one word on double-click and has no `-` or `_`. 32 bytes need 43 digits.
const base62Alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const keyBodyLength = 43;
const keyBodyPattern = new RegExp(`^[0-9A-Za-z]{${keyBodyLength}}$`);

/** Fixed-width base62 of the bytes as one big-endian number, padded with leading zeros. */
export const encodeBase62 = (bytes: Uint8Array, width: number): string => {
  let value = bytes.reduce((result, byte) => (result << 8n) | BigInt(byte), 0n);
  let digits = '';
  while (value > 0n) {
    digits = base62Alphabet[Number(value % 62n)] + digits;
    value /= 62n;
  }

  return digits.padStart(width, '0');
};

/** A new key of the given kind: its prefix, then 32 random bytes in base62 (AK-3). */
export const generateApiKey = (kind: KeyKind, prefixes: KeyPrefixes, random: RandomSource = cryptoRandomSource): Secret => {
  const bytes = random.bytes(keyBytes);
  if (bytes.length !== keyBytes)
    throw new Error(`The random source returned ${bytes.length} bytes instead of ${keyBytes}`);

  const key = Secret.from(`${prefixes[kind]}${encodeBase62(bytes, keyBodyLength)}`);
  bytes.fill(0);

  return key;
};

/** The SHA-256 of the whole key, prefix included, in hex. The only form of a key that is stored (AK-3). */
export const hashApiKey = (key: Secret): string => createHash('sha256').update(key.expose(), 'utf8').digest('hex');

/** The kind of key a value claims to be, from its prefix alone, before any lookup (AK-4). */
export const keyKindOf = (value: string, prefixes: KeyPrefixes): KeyKind | undefined =>
  keyKinds.find(kind => value.startsWith(prefixes[kind]));

/** Whether a value has the shape of a key of this kind: its prefix and 43 base62 characters. */
export const isWellFormedKey = (value: string, kind: KeyKind, prefixes: KeyPrefixes): boolean =>
  value.startsWith(prefixes[kind]) && keyBodyPattern.test(value.slice(prefixes[kind].length));
