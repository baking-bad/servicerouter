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
  it('loads the example config from CONFIG_PATH (PC-1)', async () => {
    const config = await loadPlatformConfig({ env: { CONFIG_PATH: examplePlatformConfigPath.pathname } });

    expect(config.environment).toBe('staging');
    expect(config.keyPrefixes).toEqual({ master: 'srm_test_', payment: 'sr_test_' });
  });

  it('loads every field group PC-2 lists from the example config (PC-2)', async () => {
    const document = await loadPlatformConfigDocument({ env: { CONFIG_PATH: examplePlatformConfigPath.pathname } });
    const config = await loadPlatformConfig({ env: { CONFIG_PATH: examplePlatformConfigPath.pathname } });

    // Set in the file, not filled in from defaults
    expect(Object.keys(document)).toEqual(expect.arrayContaining([
      'urls', 'ownHosts', 'assets', 'facilitators', 'mpp', 'feeBps', 'routingFeeBps', 'payouts', 'categories',
      'rateLimits', 'timeouts', 'signer', 'keyPrefixes', 'paymentKeyDefaults', 'smtp',
    ]));
    expect(document.payouts.minimum).toBeDefined();
    // Canonical public URLs and the hosts we own
    expect(config.urls).toEqual({ website: expect.any(String), api: expect.any(String), pay: expect.any(String) });
    expect(config.ownHosts).toEqual(expect.arrayContaining(Object.values(config.urls).map(url => new URL(url).hostname)));
    // The asset registry, with payTo per network
    expect(config.assets.length).toBeGreaterThan(0);
    expect(config.assets.every(asset => asset.payTo.length > 0)).toBe(true);
    // The facilitator registry: name, URL, networks, auth reference
    expect(config.facilitators.length).toBeGreaterThan(0);
    expect(config.facilitators.every(facilitator => facilitator.name && facilitator.url && facilitator.networks.length > 0)).toBe(true);
    expect(config.facilitators.some(facilitator => facilitator.auth !== undefined)).toBe(true);
    // The MPP recipient on Tempo
    expect(config.mpp.network.chain).toBe('tempo');
    expect(config.mpp.recipient).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(config.feeBps).toEqual(expect.any(Number));
    expect(config.routingFeeBps).toEqual(expect.any(Number));
    expect(config.payouts.minimum).toBe(10_000_000n);
    expect(config.categories.length).toBeGreaterThan(0);
    expect(Object.keys(config.rateLimits)).toEqual(['paymentKey', 'service', 'unpaidIp', 'signup', 'topup']);
    // Deposits (DP-1 to DP-4): a Cardano asset, its confirmations, and Blockfrost's URL for its network
    expect(config.deposits).toMatchObject({
      asset: { name: 'cardano-usdm' }, network: { id: 'cardano:preprod' }, confirmations: 15, blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    });
    expect(Object.keys(config.timeouts)).toEqual(['connectMs', 'requestMs', 'settleMs']);
    expect(config.signer.maxPerCall).toBe(1_000_000n);
    // Key prefixes and the default limits for new payment keys
    expect(config.keyPrefixes).toEqual({ master: 'srm_test_', payment: 'sr_test_' });
    expect(config.paymentKeyDefaults.dailyBudget).toBe(5_000_000n);
    // The SMTP relay, with credentials by name
    expect(config.smtp).toEqual({ host: 'smtp.example.com', port: 587, from: expect.any(String), username: 'SMTP_USERNAME', password: 'SMTP_PASSWORD' });
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
  ])('rejects %s, so the app doesn\'t start (PC-1)', async (_name, env) => {
    expect(await rejection(load(env))).toBeInstanceOf(ConfigLoadError);
  });

  it('rejects oversized files before reading them (PC-1)', async () => {
    await writeFile(path.join(directory, 'large.yaml'), 'x'.repeat(1024 * 1024 + 1));
    const error = await rejection(load({ CONFIG_PATH: 'large.yaml' }));

    expect(error).toBeInstanceOf(ConfigLoadError);
    expect((error as ConfigLoadError).cause).toMatchObject({ message: 'the file exceeds the 1048576-byte size limit' });
  });

  it('reports syntax errors with the file, line, and column (PC-1)', async () => {
    await writeFile(path.join(directory, 'broken.yaml'), 'feeBps: 1\nfeeBps: 2\n');
    const error = await rejection(load({ CONFIG_PATH: 'base.yaml,broken.yaml' }));

    expect(error).toBeInstanceOf(DocumentError);
    expect(error).toMatchObject({ source: 'broken.yaml', line: 2, column: 1, reason: 'duplicate key' });
  });

  it('rejects invalid UTF-8 and invalid inline YAML (PC-1)', async () => {
    await writeFile(path.join(directory, 'binary.yaml'), Buffer.from([0xff, 0xfe]));

    expect(await rejection(load({ CONFIG_PATH: 'binary.yaml' }))).toMatchObject({ reason: 'it is not valid UTF-8' });
    expect(await rejection(load({ CONFIG: base64([1, 2]) }))).toMatchObject({ source: 'CONFIG', reason: 'the root must be a mapping' });
  });

  it('attributes schema errors to the file that set the value (PC-1)', async () => {
    await writeFile(path.join(directory, 'bad-fee.yaml'), '# Overrides\nfeeBps: lots\n');
    const error = await rejection(load({ CONFIG_PATH: 'base.yaml,bad-fee.yaml' }));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues).toEqual([
      { path: '/feeBps', message: 'must be an integer', source: 'bad-fee.yaml', line: 2, column: 9 },
    ]);
  });

  it('reports every cross-field problem at once, with positions (PC-1, PC-5, PC-7)', async () => {
    const broken = example
      .replace('master: srm_test_', 'master: sr_test_')
      .replace(/(\nmpp:[^\n]*\n {2}network: )eip155:42431/, '$1eip155:4217');
    const error = await rejection(load({ CONFIG: base64(broken) }));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues.map(issue => [issue.path, issue.source])).toEqual([
      ['/keyPrefixes/payment', 'CONFIG'],
      // The Tempo asset stays on Moderato, so it is no longer on mpp.network (PC-6)
      ['/assets/3/network', 'CONFIG'],
      ['/mpp/network', 'CONFIG'],
    ]);
    expect((error as ValidationError).issues.every(issue => issue.line !== undefined)).toBe(true);
  });
});

describe('the deposits section (DP-1, DP-4, PC-2)', () => {
  const withDeposits = (deposits: unknown) => loadPlatformConfig({
    env: { CONFIG_PATH: examplePlatformConfigPath.pathname, CONFIG: Buffer.from(JSON.stringify({ deposits })).toString('base64') },
  });

  it('refuses an asset outside the registry, or one that isn\'t on Cardano', async () => {
    await expect(withDeposits({ asset: 'no-such-asset' })).rejects.toThrow('Invalid platform config');
    await expect(withDeposits({ asset: 'base-usdc' })).rejects.toMatchObject({ issues: [expect.objectContaining({ message: 'must be a Cardano asset: deposit addresses are on Cardano' })] });
  });

  it('turns deposits off with enabled: false, and keeps a custom Blockfrost URL', async () => {
    expect((await withDeposits({ asset: 'cardano-usdm', enabled: false })).deposits).toBeUndefined();
    expect((await withDeposits({ asset: 'cardano-usdm', blockfrostUrl: 'https://blockfrost.example.com/api/v0/' })).deposits?.blockfrostUrl)
      .toBe('https://blockfrost.example.com/api/v0');
  });
});
