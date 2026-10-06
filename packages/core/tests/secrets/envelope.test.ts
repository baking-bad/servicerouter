import { createHash, createPublicKey, webcrypto } from 'node:crypto';
import { inspect } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { redactedMessage, Secret } from '@servicerouter/common';

import {
  createSecretOpener, createSecretSealer, encodeAssociatedData, SecretBindingInvalidError, SecretOpenFailedError, type SealedSecret,
  type SecretSealer,
} from '../../src/index.js';
import { generateRsaKeyPair, type PemKeyPair } from './keyPairs.js';

const plaintext = 'sk-live-0123456789abcdef-é';
const target = { serviceId: 'my-app', name: 'weather-key', origin: 'https://api.example.com' };

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
    ['another service ID', { ...target, serviceId: 'other-app' }],
    ['another name', { ...target, name: 'files-key' }],
  ])('refuses to open under %s (SC-3)', (_name, where) => {
    expect(failure(() => opener(current).open({ ...where, sealed: seal() }))).toBeInstanceOf(SecretOpenFailedError);
  });

  it.each([
    ['another host', 'https://evil.example.net'],
    ['a subdomain of its host', 'https://x.api.example.com'],
    ['another port', 'https://api.example.com:8443'],
    ['plain HTTP on the same host', 'http://api.example.com'],
  ])('refuses to open for %s, with secret_open_failed (SC-10)', (_name, origin) => {
    const error = failure(() => opener(current).open({ ...target, origin, sealed: seal() }));

    expect(error).toBeInstanceOf(SecretOpenFailedError);
    expect(error).toMatchObject({ code: 'secret_open_failed' });
    expect(opener(current).open({ ...target, sealed: seal() }).expose()).toBe(plaintext);
  });

  it('opens with an origin that has a port, as new URL(baseUrl).origin gives it (SC-10)', () => {
    const where = { ...target, origin: new URL('https://api.example.com:8443/v2/').origin };

    expect(opener(current).open({ ...where, sealed: seal(plaintext, where) }).expose()).toBe(plaintext);
  });

  it('keeps names apart that a naive join would merge (SC-3)', () => {
    const where = { ...target, serviceId: 'a', name: 'b-c' };
    const sealed = seal(plaintext, where);
    const encode = (serviceId: string, name: string) => encodeAssociatedData({ version: 1, keyId: 'k', serviceId, name, origin: target.origin });

    expect(opener(current).open({ ...where, sealed }).expose()).toBe(plaintext);
    expect(failure(() => opener(current).open({ ...where, serviceId: 'a-b', name: 'c', sealed }))).toBeInstanceOf(SecretOpenFailedError);
    expect(encode('a', 'b-c').equals(encode('a-b', 'c'))).toBe(false);
    expect(encode('a', 'b:c').equals(encode('a:b', 'c'))).toBe(false);
  });

  it('encodes the associated data exactly as documented, with the origin last (SC-3, SC-10)', () => {
    const label = 'servicerouter.sealed-secret';
    const field = (value: string) => [...Buffer.from([0, 0, 0, Buffer.byteLength(value)])].concat([...Buffer.from(value)]);

    expect([...encodeAssociatedData({ version: 1, keyId: 'kid', serviceId: 'a', name: 'b-c', origin: 'https://x.io' })])
      .toEqual([...field(label), 1, ...field('kid'), ...field('a'), ...field('b-c'), ...field('https://x.io')]);
  });

  it.each([
    ['a version over one byte', { version: 256 }],
    ['a negative version', { version: -1 }],
    ['a fractional version', { version: 1.5 }],
    ['a lone surrogate', { name: '\uD800' }],
  ])('refuses to encode associated data with %s, with secret_binding_invalid (backlog D-4)', (_name, change) => {
    const encode = () => encodeAssociatedData({ version: 1, keyId: 'kid', serviceId: 'a', name: 'b', origin: 'https://x.io', ...change });

    expect(encode).toThrow(SecretBindingInvalidError);
    expect(failure(encode)).toMatchObject({ code: 'secret_binding_invalid' });
    expect(encodeAssociatedData({ version: 255, keyId: 'kid', serviceId: 'a', name: 'b', origin: 'https://x.io' })).toBeInstanceOf(Buffer);
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
      { name: 'AES-GCM', iv: sealed.iv, additionalData: encodeAssociatedData({ version: 1, keyId: sealed.keyId, ...target }), tagLength: 128 },
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
      failure(() => opener(current).open({ ...target, serviceId: 'other-app', sealed })),
      failure(() => opener(current).open({ ...target, origin: 'https://evil.example.net', sealed })),
      failure(() => opener(previous).open({ ...target, sealed })),
    ];

    for (const error of errors) {
      const shown = [(error as Error).message, JSON.stringify(error), inspect(error, { depth: 5 })].join('\n');
      expect(forbidden.filter(text => shown.includes(text))).toEqual([]);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('host binding when sealing (SC-10)', () => {
  it.each([
    ['plain HTTP', 'http://api.example.com'],
    ['a path', 'https://api.example.com/v2'],
    ['a trailing slash', 'https://api.example.com/'],
    ['an uppercase host', 'https://API.example.com'],
    ['the default port spelled out', 'https://api.example.com:443'],
    ['a user name', 'https://user@api.example.com'],
    ['not a URL', 'api.example.com'],
    ['the empty string', ''],
  ])('refuses an origin with %s, with secret_binding_invalid', (_name, origin) => {
    const error = failure(() => sealer.seal({ ...target, origin, value: Secret.from(plaintext) }));

    expect(error).toBeInstanceOf(SecretBindingInvalidError);
    expect(error).toMatchObject({ code: 'secret_binding_invalid', message: 'The origin must be an HTTPS origin, such as https://api.example.com' });
    expect(failure(() => opener(current).open({ ...target, origin, sealed: seal() }))).toBeInstanceOf(SecretOpenFailedError);
  });
});

describe('backlog regressions (SC-2)', () => {
  it.each([
    ['iv is null', { iv: null }],
    ['tag is undefined', { tag: undefined }],
    ['ciphertext is null', { ciphertext: null }],
    ['wrappedKey is undefined', { wrappedKey: undefined }],
    ['the version is missing', { version: undefined }],
  ])('gives secret_open_failed, not a TypeError, when %s (backlog D-1)', (_name, change) => {
    const sealed = { ...seal(), ...change } as unknown as SealedSecret;
    const error = failure(() => opener(current).open({ ...target, sealed }));

    expect(error).toBeInstanceOf(SecretOpenFailedError);
    expect((error as Error).cause).toBeUndefined();
  });

  it.each([
    ['the sealed value is null', null],
    ['the sealed value is undefined', undefined],
  ])('gives secret_open_failed when %s (backlog D-1)', (_name, sealed) => {
    expect(failure(() => opener(current).open({ ...target, sealed: sealed as unknown as SealedSecret }))).toBeInstanceOf(SecretOpenFailedError);
  });

  it('gives each byte field memory of its own, never a view into Node\'s shared pool (backlog D-3)', () => {
    for (const value of [plaintext, '', 'x']) {
      const sealed = seal(value);
      for (const field of [sealed.wrappedKey, sealed.iv, sealed.ciphertext, sealed.tag]) {
        expect(field.byteOffset).toBe(0);
        expect(field.buffer.byteLength).toBe(field.byteLength);
      }
      // A clone carries the field's bytes and nothing else
      expect(structuredClone(sealed.tag).buffer.byteLength).toBe(16);
    }
  });

  it.each([
    ['an uppercase service ID', { serviceId: 'My-App' }, 'The service ID is not valid'],
    ['an empty service ID', { serviceId: '' }, 'The service ID is not valid'],
    ['a service ID that isn\'t a string', { serviceId: 42 }, 'The service ID is not valid'],
    ['a name with a colon', { name: 'weather:key' }, 'The secret name must be 1–64 lowercase letters, digits, hyphens, or underscores'],
    ['a name over 64 characters', { name: 'k'.repeat(65) }, 'The secret name must be 1–64 lowercase letters, digits, hyphens, or underscores'],
    ['a lone surrogate in the name', { name: '\uD800' }, 'The secret name must be 1–64 lowercase letters, digits, hyphens, or underscores'],
    ['a missing origin', { origin: undefined }, 'The origin must be an HTTPS origin, such as https://api.example.com'],
  ])('refuses to seal with %s, with a coded error that quotes no value (backlog D-5)', (_name, change, message) => {
    const error = failure(() => sealer.seal({ ...target, ...change, value: Secret.from(plaintext) } as never));

    expect(error).toBeInstanceOf(SecretBindingInvalidError);
    expect(error).toMatchObject({ code: 'secret_binding_invalid', message });
    expect(inspect(error, { depth: 5 })).not.toContain(plaintext);
  });

  it.each([
    ['a 4-byte tag', 'tag', 4],
    ['a 12-byte tag', 'tag', 12],
    ['a 17-byte tag', 'tag', 17],
    ['an 8-byte IV', 'iv', 8],
    ['a 16-byte IV', 'iv', 16],
  ] as const)('refuses %s with secret_open_failed (backlog D-6)', (_name, field, length) => {
    const sealed = seal();
    // The real bytes, cut or padded: only the length is wrong
    const bytes = Buffer.alloc(length);
    bytes.set(sealed[field].subarray(0, length));

    expect(failure(() => opener(current).open({ ...target, sealed: { ...sealed, [field]: bytes } }))).toBeInstanceOf(SecretOpenFailedError);
  });
});
