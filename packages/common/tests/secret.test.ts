import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { MissingSecretError, readSecret, redactedMessage, Secret, SecretDestroyedError } from '../src/index.js';

describe('Secret (CK-1)', () => {
  const value = 'sk_live_do-not-print';

  it('redacts in JSON, inspect, and template strings', () => {
    const secret = Secret.from(value);

    expect(JSON.stringify({ secret })).toBe(`{"secret":"${redactedMessage}"}`);
    expect(inspect(secret)).toBe(redactedMessage);
    expect(inspect({ nested: { secret } })).not.toContain(value);
    expect(`${secret}`).toBe(redactedMessage);
    expect(String(secret)).toBe(redactedMessage);
  });

  it('exposes the value only on request', () => {
    expect(Secret.from(value).expose()).toBe(value);
    expect(Secret.from('пароль 🔑').expose()).toBe('пароль 🔑');
  });

  it('compares values', () => {
    expect(Secret.from(value).equals(Secret.from(value))).toBe(true);
    expect(Secret.from(value).equals(Secret.from(`${value}x`))).toBe(false);
    expect(Secret.from('aaaa').equals(Secret.from('aaab'))).toBe(false);
  });

  it('throws on any use after destroy', () => {
    const secret = Secret.from(value);
    secret.destroy();
    secret.destroy();

    expect(() => secret.expose()).toThrow(SecretDestroyedError);
    expect(() => secret.equals(Secret.from(value))).toThrow(SecretDestroyedError);
    expect(() => Secret.from(value).equals(secret)).toThrow(SecretDestroyedError);
    expect(JSON.stringify(secret)).toBe(`"${redactedMessage}"`);
  });

  it('reads secrets by name from the environment', () => {
    expect(readSecret('CDP_API_KEY_SECRET', { CDP_API_KEY_SECRET: value }).expose()).toBe(value);
  });

  it.each([
    ['unset', {}],
    ['empty', { CDP_API_KEY_SECRET: '' }],
  ])('rejects an %s secret without echoing anything but its name', (_name, env) => {
    expect(() => readSecret('CDP_API_KEY_SECRET', env)).toThrow(MissingSecretError);
    expect(() => readSecret('CDP_API_KEY_SECRET', env)).toThrow('Secret CDP_API_KEY_SECRET is not set');
  });
});
