import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadPlatformConfig } from '../../src/index.js';

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

const filled = (yaml: string): string => yaml
  .replace('FILL_ME_BASE_TREASURY', '"0x1111111111111111111111111111111111111111"')
  .replace('FILL_ME_CARDANO_TREASURY', 'addr1v9zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q09h6pt')
  .replaceAll('FILL_ME_TEMPO_RECIPIENT', '"0x2222222222222222222222222222222222222222"');

describe('config/production.yaml (PC-1, PC-5, P-1 to P-9)', () => {
  it('refuses to start until the owner fills in each treasury address, naming each one', async () => {
    await expect(loadText(text)).rejects.toThrow(/assets\/0\/payTo: is not a valid address on Base[\s\S]*assets\/1\/payTo: is not a valid address on Cardano[\s\S]*mpp\/recipient: is not a valid address on Tempo/);
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
    expect(config.urls.website).toBe('https://servicerouter.agents.bakingbad.dev');
    expect(config.rateLimits.signup).toEqual({ requests: 200, windowSeconds: 3600 });
    expect(config.rateLimits.documents).toEqual({ requests: 600, windowSeconds: 60 });
    expect(config.rateLimits.topup).toEqual({ requests: 300, windowSeconds: 60 });
    expect({ feeBps: config.feeBps, routingFeeBps: config.routingFeeBps }).toEqual({ feeBps: 0, routingFeeBps: 0 });
    expect(config.deposits?.asset.name ?? config.deposits?.asset).toBe('cardano-usdm');
  });
});
