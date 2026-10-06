import { describe, expect, it } from 'vitest';

import { findNetwork, isValidAddress, isValidAssetAddress, type NetworkInfo } from '../src/index.js';

const network = (id: string): NetworkInfo => findNetwork(id)!;
const cardano = network('cardano:mainnet');
const preprod = network('cardano:preprod');
const base = network('eip155:8453');
const solana = network('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');

describe('isValidAddress', () => {
  // CIP-19 test vectors
  it.each([
    ['base', 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x', cardano],
    ['testnet base', 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae', preprod],
    ['enterprise', 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8', cardano],
    ['testnet enterprise', 'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz', preprod],
    ['pointer', 'addr1gx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrzqf96k', cardano],
  ])('accepts a Cardano %s address', (_name, address, on) => {
    expect(isValidAddress(on, address)).toBe(true);
  });

  it.each([
    ['a bad checksum', 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl9', cardano],
    ['a testnet address on mainnet', 'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz', cardano],
    ['a mainnet address on preprod', 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8', preprod],
    ['a mainnet prefix with a testnet header', 'addr1vpzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q0h8tpv', cardano],
    ['a stake address', 'stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw', cardano],
    ['uppercase', 'ADDR1VX2FXV2UMYHTTKXYXP8X0DLPDT3K6CWNG5PXJ3JHSYDZERS66HRL8', cardano],
    ['a Byron address', 'Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi', cardano],
    ['an EVM address', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', cardano],
  ])('rejects %s', (_name, address, on) => {
    expect(isValidAddress(on, address)).toBe(false);
  });

  it('checks EVM and Solana addresses lexically', () => {
    expect(isValidAddress(base, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(true);
    expect(isValidAddress(base, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA0291')).toBe(false);
    expect(isValidAddress(base, '833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false);
    expect(isValidAddress(solana, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
    expect(isValidAddress(solana, '11111111111111111111111111111111')).toBe(true);
    // 0, O, I and l aren't base58; a 31-byte key isn't a Solana key
    expect(isValidAddress(solana, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt10')).toBe(false);
    expect(isValidAddress(solana, '1111111111111111111111111111111')).toBe(false);
  });
});

describe('isValidAssetAddress', () => {
  it('accepts the launch assets', () => {
    expect(isValidAssetAddress(base, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(true);
    expect(isValidAssetAddress(solana, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
    expect(isValidAssetAddress(cardano, 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d')).toBe(true);
  });

  it.each([
    'lovelace',
    'C48CBB3D5E57ED56E276BC45F99AB39ABE94E6CD7AC39FB402DA47AD.0014DF105553444D',
    'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d',
  ])('rejects the Cardano asset %s', asset => {
    expect(isValidAssetAddress(cardano, asset)).toBe(false);
  });
});
