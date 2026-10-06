import { ServiceRouterError, type Secret, type ServiceId } from '@servicerouter/common';

export const sealedSecretVersion = 1;

/**
 * A secret sealed for the proxy (SC-2): AES-256-GCM under a fresh data key, and the data key wrapped
 * with the proxy's public key. Plain data with no methods, so it maps to columns. The object is
 * frozen; the byte arrays are not, as typed arrays can't be.
 */
export interface SealedSecret {
  readonly version: typeof sealedSecretVersion;
  // The key pair that wrapped the data key (S2-D3), so the pair can rotate
  readonly keyId: string;
  // The 32-byte data key, under RSA-OAEP with SHA-256
  readonly wrappedKey: Uint8Array;
  // 12 bytes
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
  // The 16-byte GCM tag
  readonly tag: Uint8Array;
}

export interface SealSecretInput {
  readonly serviceId: ServiceId;
  readonly name: string;
  // The origin of the upstream the secret is sent to, as `new URL(baseUrl).origin` gives it (SC-10)
  readonly origin: string;
  readonly value: Secret;
}

export interface OpenSecretInput {
  readonly serviceId: ServiceId;
  readonly name: string;
  // The origin of the runtime upstream that uses the secret, never one stored next to it (SC-10)
  readonly origin: string;
  readonly sealed: SealedSecret;
}

/** Port: seals with a public key only, so its holder (the Platform API) can't open anything. */
export interface SecretSealer {
  readonly keyId: string;
  /** Throws SecretBindingInvalidError for a malformed service ID, secret name, or origin. */
  seal(input: SealSecretInput): SealedSecret;
}

/** Port: opens with the private keys it holds, picked by key ID. Only the proxy has one. */
export interface SecretOpener {
  // The IDs of the keys it holds, in the order given
  readonly keyIds: readonly string[];
  /** Throws SecretOpenFailedError for any failure, without saying which. */
  open(input: OpenSecretInput): Secret;
}

/**
 * Anything that stops a secret from opening: tampering, another service ID, name, or origin, an
 * unknown key ID, an unsupported version, or a malformed sealed value. One error, so a failure tells
 * an attacker nothing.
 */
export class SecretOpenFailedError extends ServiceRouterError {
  readonly code = 'secret_open_failed';

  constructor() {
    super('The secret could not be opened');
  }
}

/** A key the sealer or opener can't use. The reason never quotes the key. */
export class SecretKeyInvalidError extends ServiceRouterError {
  readonly code = 'secret_key_invalid';
}

/**
 * What a secret would be bound to isn't valid (SC-3, SC-10): a malformed service ID or secret name,
 * an origin that isn't an HTTPS origin, or a version outside one byte. The reason never quotes a value.
 */
export class SecretBindingInvalidError extends ServiceRouterError {
  readonly code = 'secret_binding_invalid';
}
