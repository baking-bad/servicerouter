import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { facilitatorFee, loadPlatformConfig } from '../../src/index.js';

// config/production.yaml (PC-1, PC-5): mainnets only, with three addresses the owner fills in
const productionConfigPath = fileURLToPath(new URL('../../../../config/production.yaml', import.meta.url));

let directory: string;
let text: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'servicerouter-production-config-'));
  text = await readFile(productionConfigPath, 'utf8');
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const loadText = async (yaml: string) => {
  await writeFile(path.join(directory, 'production.yaml'), yaml);

  return loadPlatformConfig({ env: { CONFIG_PATH: 'production.yaml' }, cwd: directory });
};

const placeholders: Readonly<Record<string, string>> = {
  'base-usdc': '"FILL_ME_BASE_TREASURY"', 'cardano-usdm': '"FILL_ME_CARDANO_TREASURY"', 'tempo-usdce': '"FILL_ME_TEMPO_RECIPIENT"',
};
const samples: Readonly<Record<string, string>> = {
  'base-usdc': '"0x1111111111111111111111111111111111111111"',
  'cardano-usdm': 'addr1v9zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q09h6pt',
  'tempo-usdce': '"0x2222222222222222222222222222222222222222"',
};

/** The config with each treasury address replaced: every asset's `payTo`, and `mpp.recipient` as Tempo's. */
const withAddresses = (yaml: string, addressFor: (asset: string) => string): string => {
  let asset = '';

  return yaml.split('\n').map(line => {
    asset = /^\s+- name: (\S+)/.exec(line)?.[1] ?? asset;
    if (/^\s+payTo: /.test(line))
      return line.replace(/payTo: .*$/, `payTo: ${addressFor(asset)}`);

    return /^\s+recipient: /.test(line) ? line.replace(/recipient: .*$/, `recipient: ${addressFor('tempo-usdce')}`) : line;
  }).join('\n');
};

// The owner's addresses once filled in, or samples while the file still has its placeholders
const filled = (yaml: string): string => yaml.includes('FILL_ME_') ? withAddresses(yaml, asset => samples[asset]!) : yaml;

describe('config/production.yaml (PC-1, PC-5, P-1 to P-9)', () => {
  it('refuses to start while a treasury address is still its placeholder, naming each one', async () => {
    await expect(loadText(withAddresses(text, asset => placeholders[asset]!))).rejects
      .toThrow(/assets\/0\/payTo: is not a valid address on Base[\s\S]*assets\/1\/payTo: is not a valid address on Cardano[\s\S]*mpp\/recipient: is not a valid address on Tempo/);
  });

  it('refuses an unquoted 0x… address, which YAML reads as a number, and says to quote it', async () => {
    const unquoted = withAddresses(text, asset => asset === 'cardano-usdm' ? samples[asset]! : '0x5d0b54076191062bea66176c6a0c94ab3aeafb26');

    await expect(loadText(unquoted)).rejects.toThrow(/assets\/0\/payTo: must be a string: put the address in quotes, since YAML reads an unquoted 0x… as a number/);
  });

  it('loads once they are filled in: mainnets only, USDC.e on Tempo, no Solana yet, live key prefixes, the temporary domain', async () => {
    const config = await loadText(filled(text));

    expect(config.environment).toBe('production');
    expect(config.assets.map(asset => [asset.name, asset.network.id, asset.decimals])).toEqual([
      ['base-usdc', 'eip155:8453', 6],
      ['cardano-usdm', 'cardano:mainnet', 6],
      ['tempo-usdce', 'eip155:4217', 6],
    ]);
    expect(config.facilitators.map(facilitator => [facilitator.name, [...facilitator.networks]])).toEqual([
      ['cdp', ['eip155:8453']],
      ['cardano', ['cardano:mainnet']],
    ]);
    expect(config.keyPrefixes).toEqual({ master: 'srm_live_', payment: 'sr_live_' });
    // One label below agents.bakingbad.dev, so its wildcard certificate covers each host (P-7)
    expect(config.urls).toEqual({
      website: 'https://servicerouter.agents.bakingbad.dev',
      api: 'https://api-servicerouter.agents.bakingbad.dev',
      pay: 'https://pay-servicerouter.agents.bakingbad.dev',
    });
    expect(config.rateLimits.signup).toEqual({ requests: 200, windowSeconds: 3600 });
    expect(config.rateLimits.documents).toEqual({ requests: 600, windowSeconds: 60 });
    expect(config.rateLimits.topup).toEqual({ requests: 300, windowSeconds: 60 });
    expect({ feeBps: config.feeBps, routingFeeBps: config.routingFeeBps }).toEqual({ feeBps: 0, routingFeeBps: 0 });
    expect(config.deposits?.asset.name ?? config.deposits?.asset).toBe('cardano-usdm');
  });

  it('reaches the Cardano facilitator by a host without an underscore, since its Tomcat answers 400 to one (PR-6)', async () => {
    const config = await loadText(filled(text));
    const cardano = config.facilitators.find(facilitator => facilitator.name === 'cardano');

    expect(cardano?.url).toBe('http://cardano-facilitator:4022');
    expect(new URL(cardano!.url).hostname).not.toContain('_');
  });

  it('takes $0.0005 on each x402 payment CDP settles, and no flat fee on Cardano or MPP (P-2)', async () => {
    const config = await loadText(filled(text));

    expect(config.facilitators.map(facilitator => [facilitator.name, facilitator.feePerPayment])).toEqual([['cdp', 500n], ['cardano', 0n]]);
    expect(facilitatorFee(config, 'eip155:8453')).toBe(500n);
    expect(facilitatorFee(config, 'cardano:mainnet')).toBe(0n);
    expect(facilitatorFee(config, config.mpp.network.id)).toBe(0n);
  });
});
