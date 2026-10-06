import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DocumentError, ValidationError } from '@servicerouter/common';

import { ConfigLoadError, loadPlatformConfig, loadPlatformConfigDocument } from '../../src/index.js';
import { examplePlatformConfigPath } from '../fixtures.js';

let directory: string;
let example: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'servicerouter-platform-config-'));
  example = await readFile(examplePlatformConfigPath, 'utf8');
  await writeFile(path.join(directory, 'base.yaml'), example);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const load = (env: Record<string, string>) => loadPlatformConfig({ env, cwd: directory });
const base64 = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  }
  catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
};

describe('loadPlatformConfig', () => {
  it('loads the example config from CONFIG_PATH', async () => {
    const config = await loadPlatformConfig({ env: { CONFIG_PATH: examplePlatformConfigPath.pathname } });

    expect(config.environment).toBe('staging');
    expect(config.keyPrefixes).toEqual({ master: 'srm_test_', payment: 'sr_test_' });
  });

  it('merges files left to right, then CONFIG; lists replace and objects merge', async () => {
    await writeFile(path.join(directory, 'override.json'), JSON.stringify({ feeBps: 100, categories: [{ id: 'weather', title: 'Weather' }], logger: { level: 'debug' } }));
    const config = await load({ CONFIG_PATH: 'base.yaml, override.json', CONFIG: base64('feeBps: 250\nrateLimits:\n  unpaidIp: { requests: 5, windowSeconds: 1 }\n') });

    expect(config.feeBps).toBe(250);
    expect(config.categories).toEqual([{ id: 'weather', title: 'Weather' }]);
    expect(config.logger.level).toBe('debug');
    expect(config.rateLimits.unpaidIp).toEqual({ requests: 5, windowSeconds: 1 });
    expect(config.rateLimits.paymentKey).toEqual({ requests: 600, windowSeconds: 60 });
  });

  it('takes the whole config from CONFIG alone', async () => {
    expect((await load({ CONFIG: base64(example) })).version).toBe(1);
  });

  it.each(['false', '0', ' FALSE '])('reads plain CONFIG when CONFIG_DECODE is %s', async flag => {
    expect((await load({ CONFIG_PATH: 'base.yaml', CONFIG: '{"feeBps": 7}', CONFIG_DECODE: flag })).feeBps).toBe(7);
  });

  it('separates loading the document from building the runtime config', async () => {
    const document = await loadPlatformConfigDocument({ env: { CONFIG_PATH: 'base.yaml' }, cwd: directory });

    // As written: amounts stay strings, defaults aren't applied
    expect(document.payouts.minimum).toBe('10');
    expect(document.ownHosts).toEqual([]);
    expect(document.assets[0]).not.toHaveProperty('minPrice');
  });

  it.each([
    ['no sources', {}],
    ['an empty CONFIG', { CONFIG: '  ' }],
    ['an empty CONFIG_PATH', { CONFIG_PATH: '' }],
    ['a trailing comma', { CONFIG_PATH: 'base.yaml,' }],
    ['an invalid CONFIG_DECODE', { CONFIG: 'e30=', CONFIG_DECODE: 'maybe' }],
    ['non-canonical base64', { CONFIG: 'e30' }],
    ['base64 with whitespace', { CONFIG: 'e30=\n' }],
    ['a missing file', { CONFIG_PATH: 'missing.yaml' }],
    ['a directory', { CONFIG_PATH: '.' }],
  ])('rejects %s', async (_name, env) => {
    expect(await rejection(load(env))).toBeInstanceOf(ConfigLoadError);
  });

  it('rejects oversized files before reading them', async () => {
    await writeFile(path.join(directory, 'large.yaml'), 'x'.repeat(1024 * 1024 + 1));
    const error = await rejection(load({ CONFIG_PATH: 'large.yaml' }));

    expect(error).toBeInstanceOf(ConfigLoadError);
    expect((error as ConfigLoadError).cause).toMatchObject({ message: 'the file exceeds the 1048576-byte size limit' });
  });

  it('reports syntax errors with the file, line, and column', async () => {
    await writeFile(path.join(directory, 'broken.yaml'), 'feeBps: 1\nfeeBps: 2\n');
    const error = await rejection(load({ CONFIG_PATH: 'base.yaml,broken.yaml' }));

    expect(error).toBeInstanceOf(DocumentError);
    expect(error).toMatchObject({ source: 'broken.yaml', line: 2, column: 1, reason: 'duplicate key' });
  });

  it('rejects invalid UTF-8 and invalid inline YAML', async () => {
    await writeFile(path.join(directory, 'binary.yaml'), Buffer.from([0xff, 0xfe]));

    expect(await rejection(load({ CONFIG_PATH: 'binary.yaml' }))).toMatchObject({ reason: 'it is not valid UTF-8' });
    expect(await rejection(load({ CONFIG: base64([1, 2]) }))).toMatchObject({ source: 'CONFIG', reason: 'the root must be a mapping' });
  });

  it('attributes schema errors to the file that set the value', async () => {
    await writeFile(path.join(directory, 'bad-fee.yaml'), '# Overrides\nfeeBps: lots\n');
    const error = await rejection(load({ CONFIG_PATH: 'base.yaml,bad-fee.yaml' }));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues).toEqual([
      { path: '/feeBps', message: 'must be an integer', source: 'bad-fee.yaml', line: 2, column: 9 },
    ]);
  });

  it('reports every cross-field problem at once, with positions', async () => {
    const broken = example
      .replace('master: srm_test_', 'master: sr_test_')
      .replace('network: eip155:42431', 'network: eip155:4217');
    const error = await rejection(load({ CONFIG: base64(broken) }));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues.map(issue => [issue.path, issue.source])).toEqual([
      ['/keyPrefixes/payment', 'CONFIG'],
      ['/mpp/network', 'CONFIG'],
    ]);
    expect((error as ValidationError).issues.every(issue => issue.line !== undefined)).toBe(true);
  });
});
