import { describe, expect, it } from 'vitest';

import { ValidationError } from '@servicerouter/common';

import {
  assertValidPlatformConfigDocument, buildPlatformConfig, findAsset, findFacilitator, platformDefaults,
  type PlatformConfigDocument,
} from '../../src/index.js';
import { loadExamplePlatformDocument, mainnetEnterpriseAddress, patch } from '../fixtures.js';

const document = (changes: unknown = {}): PlatformConfigDocument => {
  const value = patch(loadExamplePlatformDocument(), changes);
  assertValidPlatformConfigDocument(value);

  return value;
};

const issues = (build: () => unknown): readonly { readonly path: string; readonly message: string }[] => {
  try {
    build();
  }
  catch (error) {
    if (error instanceof ValidationError)
      return error.issues;
    throw error;
  }
  throw new Error('Expected a ValidationError');
};

const minimalOptionalFields = {
  logger: undefined, ownHosts: undefined, paymentKeyDefaults: undefined, timeouts: undefined,
  sizeLimits: undefined, signer: undefined, smtp: undefined, payouts: { minimum: undefined },
};

describe('buildPlatformConfig', () => {
  it('builds the example config, with secrets by name only (PC-3, PC-6)', () => {
    const config = buildPlatformConfig(document());

    expect(config.environment).toBe('staging');
    expect(config.assets.map(asset => asset.name)).toEqual(['base-usdc', 'solana-usdc', 'cardano-usdm']);
    expect(findAsset(config, 'cardano-usdm')).toMatchObject({ decimals: 6, minPrice: 50_000n, network: { id: 'cardano:preprod', testnet: true } });
    expect(findFacilitator(config, 'eip155:84532')?.auth).toEqual({ type: 'cdp', apiKeyId: 'CDP_API_KEY_ID', apiKeySecret: 'CDP_API_KEY_SECRET' });
    expect(findFacilitator(config, 'cardano:preprod')).toMatchObject({ name: 'cardano', auth: undefined });
    expect(config.ownHosts).toEqual(['staging.servicerouter.ai', 'api.staging.servicerouter.ai', 'pay.staging.servicerouter.ai']);
    expect(config.mpp.network.chain).toBe('tempo');
  });

  it('enables a facilitator unless it says enabled: false (PC-2, PR-6)', () => {
    const config = buildPlatformConfig(document());
    const withoutCardano = loadExamplePlatformDocument() as { facilitators: Record<string, unknown>[] };
    withoutCardano.facilitators[1]!['enabled'] = false;
    delete withoutCardano.facilitators[0]!['enabled'];

    // Cardano is on in the example since step 6
    expect(config.facilitators.map(facilitator => [facilitator.name, facilitator.enabled])).toEqual([['cdp', true], ['cardano', true]]);
    expect(buildPlatformConfig(withoutCardano as never).facilitators.map(facilitator => [facilitator.name, facilitator.enabled])).toEqual([['cdp', true], ['cardano', false]]);
    const notBoolean = loadExamplePlatformDocument() as { facilitators: Record<string, unknown>[] };
    notBoolean.facilitators[0]!['enabled'] = 'no';
    expect(issues(() => assertValidPlatformConfigDocument(notBoolean)).map(issue => issue.path)).toEqual(['/facilitators/0/enabled']);
  });

  it('applies the documented defaults (PC-2, PC-6)', () => {
    const config = buildPlatformConfig(document(minimalOptionalFields));

    expect(config.logger.level).toBe('info');
    expect(config.paymentKeyDefaults.dailyBudget).toBe(5_000_000n);
    expect(config.payouts.minimum).toBe(10_000_000n);
    expect(config.timeouts).toEqual(platformDefaults.timeouts);
    expect(config.sizeLimits).toEqual({ requestBodyBytes: 1_048_576, bufferedResponseBytes: 10_485_760 });
    expect(config.signer).toEqual({ maxPerCall: 1_000_000n, maxPerNetworkPerHour: undefined, maxPerNetworkPerDay: 100_000_000n });
    expect(config.smtp).toBeUndefined();
    expect(findAsset(config, 'base-usdc')?.minPrice).toBe(0n);
  });

  it('merges partial overrides with defaults and normalizes own hosts (PC-2)', () => {
    const config = buildPlatformConfig(document({ timeouts: { connectMs: 1_000 }, ownHosts: ['Edge.ServiceRouter.ai', '203.0.113.7'] }));

    expect(config.timeouts).toEqual({ connectMs: 1_000, requestMs: 30_000, settleMs: 30_000 });
    expect(config.ownHosts).toContain('edge.servicerouter.ai');
    expect(config.ownHosts).toContain('203.0.113.7');
  });

  it('is deeply frozen and doesn\'t change the document (PC-4)', () => {
    const source = document();
    const before = structuredClone(source);
    const config = buildPlatformConfig(source);

    expect(source).toEqual(before);
    expect(Object.isFrozen(config.assets[0]!.network)).toBe(true);
    expect(Object.isFrozen(config.rateLimits.paymentKey)).toBe(true);
  });

  it('freezes every object in the built config, so it is read-only at runtime (PC-4)', () => {
    const config = buildPlatformConfig(document());
    const unfrozen = (value: unknown, path: string): readonly string[] => typeof value === 'object' && value !== null
      ? [...Object.isFrozen(value) ? [] : [path || '/'], ...Object.entries(value).flatMap(([key, nested]) => unfrozen(nested, `${path}/${key}`))]
      : [];

    expect(unfrozen(config, '')).toEqual([]);
    expect(() => Object.assign(config.urls, { api: 'https://evil.example.com' })).toThrow(TypeError);
    expect(() => (config.assets as unknown[]).push({})).toThrow(TypeError);
  });

  it.each([
    ['equal key prefixes (PC-7)', { keyPrefixes: { payment: 'srm_test_' } }, '/keyPrefixes/payment'],
    ['a key prefix that starts with the other (PC-7)', { keyPrefixes: { master: 'sr_test_master_' } }, '/keyPrefixes/payment'],
    ['a mainnet in staging (PC-5)', { mpp: { network: 'eip155:4217' } }, '/mpp/network'],
    ['an unsupported network (PC-6)', { facilitators: [{ name: 'x', url: 'https://x.example.com', networks: ['eip155:1'] }] }, '/facilitators/0/networks/0'],
    ['a non-Tempo MPP network (PC-2)', { mpp: { network: 'eip155:84532' } }, '/mpp/network'],
    ['an invalid MPP recipient (PC-2)', { mpp: { recipient: '0x12' } }, '/mpp/recipient'],
    ['a payout asset outside the registry (PC-6)', { payouts: { assets: ['cardano-ada'] } }, '/payouts/assets/0'],
    ['an amount that overflows', { payouts: { minimum: '99999999999999' } }, '/payouts/minimum'],
  ])('rejects %s', (_name, changes, path) => {
    expect(issues(() => buildPlatformConfig(document(changes))).map(issue => issue.path)).toContain(path);
  });

  it('rejects mainnets in staging and testnets in production (PC-5)', () => {
    const production = issues(() => buildPlatformConfig(document({ environment: 'production' })));

    expect(production).toContainEqual({ path: '/assets/0/network', message: 'Base Sepolia is a testnet; production uses mainnets' });
    expect(production).toContainEqual({ path: '/mpp/network', message: 'Tempo Moderato is a testnet; production uses mainnets' });
  });

  it('checks every asset against its network (PC-6)', () => {
    const value = loadExamplePlatformDocument();
    const assets = value['assets'] as Record<string, unknown>[];
    assets[0] = { ...assets[0], address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };
    assets[2] = { ...assets[2], payTo: mainnetEnterpriseAddress };
    assets.push({ ...assets[1], name: 'base-usdc' });
    assertValidPlatformConfigDocument(value);

    expect(issues(() => buildPlatformConfig(value))).toEqual([
      { path: '/assets/0/address', message: 'is not a valid token address on Base Sepolia' },
      { path: '/assets/2/payTo', message: 'is not a valid address on Cardano Preprod' },
      { path: '/assets/3/name', message: 'duplicate asset name "base-usdc"' },
      { path: '/assets/3/address', message: 'another asset already uses this token on the same network' },
    ]);
  });

  it('requires exactly one facilitator for each asset network (PC-2)', () => {
    const value = loadExamplePlatformDocument();
    const facilitators = value['facilitators'] as Record<string, unknown>[];
    value['facilitators'] = [facilitators[0], { ...facilitators[0], name: 'cdp' }];
    assertValidPlatformConfigDocument(value);

    expect(issues(() => buildPlatformConfig(value))).toEqual([
      { path: '/facilitators/1/name', message: 'duplicate facilitator name "cdp"' },
      { path: '/facilitators/1/networks/0', message: 'facilitator "cdp" already serves this network' },
      { path: '/facilitators/1/networks/1', message: 'facilitator "cdp" already serves this network' },
      { path: '/assets/2/network', message: 'no facilitator serves this network' },
    ]);
  });
});

describe('assertValidPlatformConfigDocument', () => {
  it.each([
    ['an unknown field (PC-1)', { colour: 'blue' }, '/colour', 'unknown field'],
    ['a missing field (PC-1)', { feeBps: undefined }, '', 'missing required field "feeBps"'],
    ['an unknown version (PC-1)', { version: 2 }, '/version', 'must be 1'],
    ['a secret value instead of its name (PC-3)', { smtp: { password: 'hunter2' } }, '/smtp/password', 'must name the environment variable that holds the secret, such as CDP_API_KEY_SECRET. Never put the value here'],
    ['a URL with a path (PC-2)', { urls: { api: 'https://api.servicerouter.ai/v1' } }, '/urls/api', 'must be an HTTPS origin, such as https://example.com, without a path or a trailing slash'],
    ['an HTTP origin (PC-2)', { urls: { pay: 'http://pay.servicerouter.ai' } }, '/urls/pay', 'must be an HTTPS origin, such as https://example.com, without a path or a trailing slash'],
    ['fees above 100%', { feeBps: 10_001 }, '/feeBps', 'must be at most 10000'],
    ['a numeric amount', { paymentKeyDefaults: { dailyBudget: 5 } }, '/paymentKeyDefaults/dailyBudget', 'must be a USD amount as a string with at most 6 decimal places, such as "0.001"'],
    ['an empty asset registry (PC-6)', { assets: [] }, '/assets', 'must have at least 1 item'],
    ['an unknown peg (PC-6)', { assets: [{ name: 'x', network: 'eip155:84532', address: '0x0', decimals: 6, peg: 'eur', payTo: '0x0' }] }, '/assets/0/peg', 'must be "usd"'],
    ['an unknown log level', { logger: { level: 'verbose' } }, '/logger/level', 'must be one of: "trace", "debug", "info", "warn", "error", "fatal"'],
    ['a missing signup rate limit (PA-5)', { rateLimits: { signup: undefined } }, '/rateLimits', 'missing required field "signup"'],
  ])('rejects %s', (_name, changes, path, message) => {
    const value = patch(loadExamplePlatformDocument(), changes);

    expect(issues(() => assertValidPlatformConfigDocument(value))).toContainEqual({ path, message });
  });

  it('rejects unsafe objects before the schema runs (PC-1)', () => {
    const value: unknown = JSON.parse('{"__proto__": {"admin": true}}');

    expect(issues(() => assertValidPlatformConfigDocument(value))).toEqual([{ path: '/__proto__', message: 'the key "__proto__" is not allowed' }]);
  });
});
