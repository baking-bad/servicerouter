import { timingSafeEqual } from 'node:crypto';

import { ServiceRouterError } from './errors.js';

export const redactedMessage = '[REDACTED]';

export class SecretDestroyedError extends ServiceRouterError {
  readonly code = 'secret_destroyed';

  constructor() {
    super('Secret destroyed');
  }
}

export class MissingSecretError extends ServiceRouterError {
  readonly code = 'missing_secret';
  readonly secretName: string;

  constructor(secretName: string) {
    super(`Secret ${secretName} is not set`);

    this.secretName = secretName;
  }
}

/**
 * Holds a credential. Every way of printing or serializing it yields a redaction marker; the value
 * comes out only through `expose()`.
 */
export class Secret {
  #buffer: Buffer | null;

  private constructor(buffer: Buffer) {
    this.#buffer = buffer;
  }

  static from(value: string): Secret {
    // Not Buffer.from: small buffers share Node's pool, and destroy() must own the memory it zeroes
    const buffer = Buffer.alloc(Buffer.byteLength(value, 'utf8'));
    buffer.write(value, 'utf8');

    return new Secret(buffer);
  }

  expose(): string {
    if (!this.#buffer)
      throw new SecretDestroyedError();

    return this.#buffer.toString('utf8');
  }

  equals(other: Secret): boolean {
    if (!this.#buffer || !other.#buffer)
      throw new SecretDestroyedError();
    if (this.#buffer.length !== other.#buffer.length)
      return false;

    return timingSafeEqual(this.#buffer, other.#buffer);
  }

  destroy(): void {
    if (!this.#buffer)
      return;

    this.#buffer.fill(0);
    this.#buffer = null;
  }

  toString(): string { return redactedMessage; }
  toJSON(): string { return redactedMessage; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return redactedMessage; }
}

export type SecretEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Reads a secret by name from the stack's environment. Config files name secrets; their values live
 * only in the environment.
 */
export const readSecret = (name: string, env: SecretEnvironment = process.env): Secret => {
  const value = env[name];
  if (value === undefined || value === '')
    throw new MissingSecretError(name);

  return Secret.from(value);
};
