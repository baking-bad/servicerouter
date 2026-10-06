import { describe, expect, it } from 'vitest';

import { isAssetName, isNetworkId, isRequestId, isServiceId } from '../src/index.js';

describe('shared identifiers (CK-9)', () => {
  it.each([
    ['req-1', true],
    ['4bf92f35-77b3-4da6-a3ce-929d0e0e4736', true],
    ['trace:1.2_3', true],
    ['r'.repeat(128), true],
    ['', false],
    ['r'.repeat(129), false],
    ['has space', false],
    ['a/b', false],
  ])('request ID %j: %s', (value, valid) => {
    expect(isRequestId(value)).toBe(valid);
  });

  it.each([
    ['my-app', true],
    ['a', true],
    ['0x', true],
    ['s'.repeat(64), true],
    ['s'.repeat(65), false],
    ['-app', false],
    ['app-', false],
    ['My-App', false],
    ['my_app', false],
    ['my.app', false],
  ])('service ID %j: %s', (value, valid) => {
    expect(isServiceId(value)).toBe(valid);
  });

  it.each([
    ['base-usdc', true],
    ['cardano-usdm', true],
    ['a'.repeat(64), true],
    ['a'.repeat(65), false],
    ['base--usdc', false],
    ['-usdc', false],
    ['Base-USDC', false],
  ])('asset name %j: %s', (value, valid) => {
    expect(isAssetName(value)).toBe(valid);
  });

  it.each([
    ['eip155:8453', true],
    ['cardano:mainnet', true],
    ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', true],
    ['eip155', false],
    ['ab:1', false],
    ['EIP155:8453', false],
    ['eip155:', false],
    ['eip155:84 53', false],
  ])('network ID (CAIP-2) %j: %s', (value, valid) => {
    expect(isNetworkId(value)).toBe(valid);
  });
});
