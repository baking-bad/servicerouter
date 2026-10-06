import type * as Crypto from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Secret } from '@servicerouter/common';

import { createSecretOpener, createSecretSealer } from '../../src/index.js';
import { generateRsaKeyPair, type PemKeyPair } from './keyPairs.js';

// Every buffer a decipher hands out, to check that `open` wipes each one
const outputs = vi.hoisted(() => [] as Buffer[]);

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof Crypto>();

  return {
    ...actual,
    createDecipheriv: (...args: Parameters<typeof actual.createDecipheriv>) => {
      const decipher = actual.createDecipheriv(...args);
      const update = decipher.update.bind(decipher) as (data: Uint8Array) => Buffer;
      const final = decipher.final.bind(decipher) as () => Buffer;
      Object.assign(decipher, {
        update: (data: Uint8Array) => {
          const output = update(data);
          outputs.push(output);

          return output;
        },
        final: () => {
          const output = final();
          outputs.push(output);

          return output;
        },
      });

      return decipher;
    },
  };
});

let pair: PemKeyPair;

beforeAll(async () => {
  pair = await generateRsaKeyPair();
});

describe('opening wipes the plaintext (backlog D-2)', () => {
  it('fills every buffer the decipher returned with zeros, once the value is in a Secret', () => {
    const where = { serviceId: 'my-app', name: 'weather-key', origin: 'https://api.example.com' };
    const value = 'sk-live-0123456789abcdef'.repeat(4);
    const sealed = createSecretSealer(pair.publicKey).seal({ ...where, value: Secret.from(value) });
    outputs.length = 0;

    const opened = createSecretOpener([Secret.from(pair.privateKey)]).open({ ...where, sealed });

    expect(opened.expose()).toBe(value);
    expect(outputs.reduce((total, output) => total + output.length, 0)).toBe(Buffer.byteLength(value));
    expect(outputs.every(output => output.every(byte => byte === 0))).toBe(true);
  });
});
