import { describe, expect, it } from 'vitest';

import { checkTempoCharge, findAsset, mppChainId } from '../../src/index.js';
import { examplePlatform } from '../fixtures.js';

// config/example.yaml: MPP on Tempo Moderato, with pathUSD
const pathUsd = findAsset(examplePlatform, 'tempo-pathusd')!;
const recipient = '0x5555555555555555555555555555555555555555';
const charge = (request: Record<string, unknown> = {}, details: Record<string, unknown> = {}) => ({
  method: 'tempo', intent: 'charge',
  request: { amount: '1500', currency: pathUsd.address, recipient, methodDetails: { chainId: 42_431, supportedModes: ['pull'], ...details }, ...request },
});

describe('a routed target\'s Tempo charge (RT-4, SG-3, T27)', () => {
  it('pays a pull-mode charge on mpp.network in an asset of the registry, at its price rounded up to the micro-USD', () => {
    expect(mppChainId(examplePlatform)).toBe(42_431);
    expect(checkTempoCharge(charge(), examplePlatform)).toEqual({
      charge: { asset: pathUsd, atomicAmount: 1_500n, price: 1_500n, recipient, sponsored: false },
    });
    // Both modes, as no `supportedModes` says; no chain ID, signed on mpp.network's; a sponsored fee
    expect(checkTempoCharge(charge({ methodDetails: { feePayer: true } }), examplePlatform).charge).toMatchObject({ sponsored: true });
    expect(checkTempoCharge(charge({}, { supportedModes: ['push', 'pull'] }), examplePlatform).charge).toBeDefined();
  });

  it.each([
    ['another method', { ...charge(), method: 'stripe' }, 'not_tempo_charge'],
    ['a session, not a charge', { ...charge(), intent: 'session' }, 'not_tempo_charge'],
    ['no recipient', charge({ recipient: undefined }), 'not_tempo_charge'],
    ['another chain', charge({}, { chainId: 4_217 }), 'wrong_chain'],
    ['push mode only', charge({}, { supportedModes: ['push'] }), 'push_only'],
    ['splits', charge({}, { splits: [{ amount: '100', recipient }] }), 'splits'],
    ['a currency outside the registry', charge({ currency: '0x20c0000000000000000000000000000000000001' }), 'unsupported_currency'],
    ['a zero amount', charge({ amount: '0' }), 'invalid_amount'],
    ['an amount that isn\'t atomic', charge({ amount: '0.001' }), 'invalid_amount'],
  ])('refuses %s', (_name, challenge, refusal) => {
    expect(checkTempoCharge(challenge, examplePlatform)).toEqual({ refusal });
  });
});
