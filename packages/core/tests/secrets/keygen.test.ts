import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { Secret } from '@servicerouter/common';

import { createSecretOpener, createSecretSealer } from '../../src/index.js';

const script = fileURLToPath(new URL('../../../../scripts/secrets-keygen.mjs', import.meta.url));

describe('scripts/secrets-keygen.mjs (SC-2, SC-4)', () => {
  it('prints a key pair that the sealer and the opener accept, with its key ID', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [script]);
    const keyId = /^# Key ID: (\S+)$/m.exec(stdout)?.[1];
    const publicKey = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/.exec(stdout)?.[0];
    const privateKey = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/.exec(stdout)?.[0];

    const sealer = createSecretSealer(publicKey!);
    const opener = createSecretOpener([Secret.from(privateKey!)]);
    const sealed = sealer.seal({ serviceId: 'my-app', name: 'weather-key', value: Secret.from('value') });

    expect(sealer.keyId).toBe(keyId);
    expect(opener.keyIds).toEqual([keyId]);
    expect(opener.open({ serviceId: 'my-app', name: 'weather-key', sealed }).expose()).toBe('value');
  });
});
