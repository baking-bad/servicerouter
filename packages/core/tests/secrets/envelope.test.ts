import { createHash, createPublicKey, webcrypto } from 'node:crypto';
import { inspect } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { redactedMessage, Secret } from '@servicerouter/common';

import {
  createSecretOpener, createSecretSealer, encodeAssociatedData, SecretOpenFailedError, type SealedSecret, type SecretSealer,
} from '../../src/index.js';
import { generateRsaKeyPair, type PemKeyPair } from './keyPairs.js';

const plaintext = 'sk-live-0123456789abcdef-é';
const target = { serviceId: 'my-app', name: 'weather-key' };

let current: PemKeyPair;
let previous: PemKeyPair;
let sealer: SecretSealer;

beforeAll(async () => {
  [current, previous] = await Promise.all([generateRsaKeyPair(), generateRsaKeyPair()]);
  sealer = createSecretSealer(current.publicKey);
});

const seal = (value = plaintext, where = target): SealedSecret => sealer.seal({ ...where, value: Secret.from(value) });
const opener = (...pairs: readonly PemKeyPair[]) => createSecretOpener(pairs.map(pair => Secret.from(pair.privateKey)));

const failure = (open: () => unknown): unknown => {
  try {
    open();
  }
  catch (error) {
    return error;
  }
  throw new Error('Expected open to fail');
};

const flipByte = (sealed: SealedSecret, field: 'wrappedKey' | 'iv' | 'ciphertext' | 'tag'): SealedSecret => {
  const bytes = Uint8Array.from(sealed[field]);
  const index = Math.floor(bytes.length / 2);
  bytes[index] = bytes[index]! ^ 0x01;

  return { ...sealed, [field]: bytes };
};

describe('secret sealing (SC-2)', () => {
  it('opens to the same value it sealed, as a Secret (SC-2)', () => {
    const opened = opener(current).open({ ...target, sealed: seal() });

    expect(opened).toBeInstanceOf(Secret);
    expect(opened.expose()).toBe(plaintext);
    expect(opener(current).open({ ...target, sealed: seal('') }).expose()).toBe('');
  });

  it('produces a frozen, plain value with the key ID and byte fields of the right size (SC-2)', () => {
    const sealed = seal();

    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.keys(sealed)).toEqual(['version', 'keyId', 'wrappedKey', 'iv', 'ciphertext', 'tag']);
    expect(sealed).toMatchObject({ version: 1, keyId: sealer.keyId });
    expect([sealed.wrappedKey, sealed.iv, sealed.ciphertext, sealed.tag].every(field => field instanceof Uint8Array)).toBe(true);
    expect([sealed.wrappedKey.length, sealed.iv.length, sealed.tag.length]).toEqual([384, 12, 16]);
    expect(sealed.ciphertext.length).toBe(Buffer.byteLength(plaintext));
  });

  it('uses a fresh data key and IV each time (SC-2)', () => {
    const first = seal();
    const second = seal();

    expect(Buffer.from(first.iv).equals(Buffer.from(second.iv))).toBe(false);
    expect(Buffer.from(first.wrappedKey).equals(Buffer.from(second.wrappedKey))).toBe(false);
    expect(Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(false);
  });

  it.each(['wrappedKey', 'iv', 'ciphertext', 'tag'] as const)('refuses to open after one byte of %s changes (SC-2)', field => {
    const error = failure(() => opener(current).open({ ...target, sealed: flipByte(seal(), field) }));

    expect(error).toBeInstanceOf(SecretOpenFailedError);
    expect(error).toMatchObject({ code: 'secret_open_failed' });
  });

  it.each([
    ['another service ID', { serviceId: 'other-app', name: 'weather-key' }],
    ['another name', { serviceId: 'my-app', name: 'files-key' }],
  ])('refuses to open under %s (SC-3)', (_name, where) => {
    expect(failure(() => opener(current).open({ ...where, sealed: seal() }))).toBeInstanceOf(SecretOpenFailedError);
  });

  it('keeps names apart that a naive join would merge (SC-3)', () => {
    const sealed = seal(plaintext, { serviceId: 'a', name: 'b:c' });

    expect(opener(current).open({ serviceId: 'a', name: 'b:c', sealed }).expose()).toBe(plaintext);
    expect(failure(() => opener(current).open({ serviceId: 'a:b', name: 'c', sealed }))).toBeInstanceOf(SecretOpenFailedError);
    expect(encodeAssociatedData(1, 'k', 'a', 'b:c').equals(encodeAssociatedData(1, 'k', 'a:b', 'c'))).toBe(false);
  });

  it('encodes the associated data exactly as documented (SC-3)', () => {
    const label = 'servicerouter.sealed-secret';
    const field = (value: string) => [...Buffer.from([0, 0, 0, Buffer.byteLength(value)])].concat([...Buffer.from(value)]);

    expect([...encodeAssociatedData(1, 'kid', 'a', 'b:c')]).toEqual([...field(label), 1, ...field('kid'), ...field('a'), ...field('b:c')]);
    expect(() => encodeAssociatedData(1, 'kid', 'a', '\uD800')).toThrow(TypeError);
  });

  it('refuses an unsupported version, and a key ID it doesn\'t hold', () => {
    const sealed = seal();

    expect(failure(() => opener(current).open({ ...target, sealed: { ...sealed, version: 2 as 1 } }))).toBeInstanceOf(SecretOpenFailedError);
    expect(failure(() => opener(current).open({ ...target, sealed: { ...sealed, keyId: 'AAAAAAAAAAAAAAAAAAAAAA' } }))).toBeInstanceOf(SecretOpenFailedError);
  });

  it('opens values sealed under either key while the pair rotates, and not without the key (SC-2)', () => {
    const old = createSecretSealer(previous.publicKey).seal({ ...target, value: Secret.from('old') });
    const fresh = seal('new');
    const both = opener(previous, current);

    expect(old.keyId).not.toBe(fresh.keyId);
    expect(both.keyIds).toEqual([old.keyId, fresh.keyId]);
    expect(both.open({ ...target, sealed: old }).expose()).toBe('old');
    expect(both.open({ ...target, sealed: fresh }).expose()).toBe('new');
    expect(failure(() => opener(current).open({ ...target, sealed: old }))).toBeInstanceOf(SecretOpenFailedError);
  });

  it('derives the key ID from the SPKI DER, the same from either half of the pair (S2-D3)', () => {
    const der = createPublicKey(current.publicKey).export({ type: 'spki', format: 'der' });
    const expected = createHash('sha256').update(der).digest().subarray(0, 16).toString('base64url');

    expect(sealer.keyId).toBe(expected);
    expect(sealer.keyId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(opener(current).keyIds).toEqual([expected]);
  });

  it('is standard RSA-OAEP with SHA-256 and MGF1-SHA-256, and AES-256-GCM: WebCrypto opens it too (SC-2)', async () => {
    const sealed = seal();
    const der = Buffer.from(current.privateKey.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    const privateKey = await webcrypto.subtle.importKey('pkcs8', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    const dataKey = await webcrypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, sealed.wrappedKey);
    const aesKey = await webcrypto.subtle.importKey('raw', dataKey, 'AES-GCM', false, ['decrypt']);
    const opened = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.iv, additionalData: encodeAssociatedData(1, sealed.keyId, target.serviceId, target.name), tagLength: 128 },
      aesKey,
      Buffer.concat([sealed.ciphertext, sealed.tag]),
    );

    expect(Buffer.from(opened).toString('utf8')).toBe(plaintext);
  });

  it('opens to a Secret that prints only the redaction marker (CK-1, SC-6)', () => {
    const opened = opener(current).open({ ...target, sealed: seal() });

    expect(String(opened)).toBe(redactedMessage);
    expect(JSON.stringify({ opened })).toBe(`{"opened":"${redactedMessage}"}`);
    expect(inspect(opened)).toBe(redactedMessage);
  });

  it('never puts the plaintext, key material, or ciphertext in an open error (SC-6)', () => {
    const sealed = seal();
    const forbidden = [
      plaintext,
      current.privateKey.split('\n')[1]!,
      Buffer.from(sealed.ciphertext).toString('hex'),
      Buffer.from(sealed.ciphertext).toString('base64'),
      Buffer.from(sealed.wrappedKey).toString('base64').slice(0, 32),
    ];
    const errors = [
      failure(() => opener(current).open({ ...target, sealed: flipByte(sealed, 'tag') })),
      failure(() => opener(current).open({ ...target, sealed: flipByte(sealed, 'wrappedKey') })),
      failure(() => opener(current).open({ serviceId: 'other-app', name: target.name, sealed })),
      failure(() => opener(previous).open({ ...target, sealed })),
    ];

    for (const error of errors) {
      const shown = [(error as Error).message, JSON.stringify(error), inspect(error, { depth: 5 })].join('\n');
      expect(forbidden.filter(text => shown.includes(text))).toEqual([]);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});
