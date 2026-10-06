import { constants, createCipheriv, createDecipheriv, privateDecrypt, publicEncrypt, randomBytes, type KeyObject } from 'node:crypto';

import { Secret } from '@servicerouter/common';

import { deriveKeyId, loadPrivateKey, loadPublicKey } from './keys.js';
import {
  SecretKeyInvalidError, SecretOpenFailedError, sealedSecretVersion, type OpenSecretInput, type SealedSecret, type SecretOpener, type SecretSealer,
} from './ports.js';

const cipherName = 'aes-256-gcm';
const dataKeyBytes = 32;
const ivBytes = 12;
const tagBytes = 16;
// Domain separation: these bytes only ever authenticate a sealed seller secret
const associatedDataLabel = 'servicerouter.sealed-secret';

// RSA-OAEP with SHA-256. OpenSSL uses the OAEP hash for MGF1 too unless told otherwise.
const oaep = (key: KeyObject) => ({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' });

// A lone surrogate would encode to U+FFFD, so two different names could share associated data
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

const field = (value: string): Buffer => {
  if (loneSurrogate.test(value))
    throw new TypeError('The service ID and secret name must be well-formed text');

  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);

  return Buffer.concat([length, bytes]);
};

/**
 * Binds a ciphertext to its format version, key ID, service ID, and secret name (SC-3):
 * label ‖ version ‖ keyId ‖ serviceId ‖ name, where the version is one byte and every string is
 * a 4-byte big-endian UTF-8 length followed by its UTF-8 bytes. Lengths make it unambiguous:
 * service `a` with name `b:c` never matches service `a:b` with name `c`.
 */
export const encodeAssociatedData = (version: number, keyId: string, serviceId: string, name: string): Buffer =>
  Buffer.concat([field(associatedDataLabel), Buffer.from([version]), field(keyId), field(serviceId), field(name)]);

// Owns its memory, unlike Buffer.from, so filling it with zeros reaches every copy we made
const toOwnedBytes = (value: string): Buffer => {
  const bytes = Buffer.alloc(Buffer.byteLength(value, 'utf8'));
  bytes.write(value, 'utf8');

  return bytes;
};

/** A sealer that holds only a public key (SC-2, SC-4). Throws SecretKeyInvalidError for a private, short, or non-RSA key. */
export const createSecretSealer = (publicKeyPem: string): SecretSealer => {
  const publicKey = loadPublicKey(publicKeyPem);
  const keyId = deriveKeyId(publicKey);

  const sealer: SecretSealer = {
    keyId,
    seal: ({ serviceId, name, value }) => {
      const associatedData = encodeAssociatedData(sealedSecretVersion, keyId, serviceId, name);
      const dataKey = randomBytes(dataKeyBytes);
      const iv = randomBytes(ivBytes);
      // A string can't be wiped, but the bytes we make from it can
      const plaintext = toOwnedBytes(value.expose());
      try {
        const cipher = createCipheriv(cipherName, dataKey, iv, { authTagLength: tagBytes });
        cipher.setAAD(associatedData);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

        return Object.freeze<SealedSecret>({
          version: sealedSecretVersion,
          keyId,
          wrappedKey: publicEncrypt(oaep(publicKey), dataKey),
          iv,
          ciphertext,
          tag: cipher.getAuthTag(),
        });
      }
      finally {
        dataKey.fill(0);
        plaintext.fill(0);
      }
    },
  };

  return Object.freeze(sealer);
};

/**
 * An opener holding one or more private keys, so the key pair can rotate. Picks the key by the sealed
 * value's key ID. Throws SecretKeyInvalidError for a key it can't use.
 */
export const createSecretOpener = (privateKeyPems: readonly Secret[]): SecretOpener => {
  if (privateKeyPems.length === 0)
    throw new SecretKeyInvalidError('The opener needs at least one private key');

  const keys = new Map<string, KeyObject>();
  for (const pem of privateKeyPems) {
    const key = loadPrivateKey(pem);
    keys.set(deriveKeyId(key), key);
  }

  const open = ({ serviceId, name, sealed }: OpenSecretInput): Secret => {
    const key = sealed.version === sealedSecretVersion ? keys.get(sealed.keyId) : undefined;
    if (!key || sealed.iv.length !== ivBytes || sealed.tag.length !== tagBytes)
      throw new SecretOpenFailedError();

    let dataKey: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      const associatedData = encodeAssociatedData(sealed.version, sealed.keyId, serviceId, name);
      dataKey = privateDecrypt(oaep(key), sealed.wrappedKey);
      if (dataKey.length !== dataKeyBytes)
        throw new SecretOpenFailedError();

      const decipher = createDecipheriv(cipherName, dataKey, sealed.iv, { authTagLength: tagBytes });
      decipher.setAAD(associatedData);
      decipher.setAuthTag(sealed.tag);
      plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);

      return Secret.from(plaintext.toString('utf8'));
    }
    catch {
      // One error for every failure, with no cause: the caller learns nothing about which check failed
      throw new SecretOpenFailedError();
    }
    finally {
      dataKey?.fill(0);
      plaintext?.fill(0);
    }
  };

  return Object.freeze({ keyIds: Object.freeze([...keys.keys()]), open });
};
