import * as AddressEras from '@evolution-sdk/evolution/AddressEras';
import * as Bip32PrivateKey from '@evolution-sdk/evolution/Bip32PrivateKey';
import * as EnterpriseAddress from '@evolution-sdk/evolution/EnterpriseAddress';
import * as KeyHash from '@evolution-sdk/evolution/KeyHash';
import * as VKey from '@evolution-sdk/evolution/VKey';
import { describe, expect, it } from 'vitest';

import { createTestDepositWallet } from '@servicerouter/testing';

import { blockfrostUnit, createDepositAddressDeriver, DepositKeyError, depositUsdAmount, findNetwork } from '../../src/index.js';

const preprod = findNetwork('cardano:preprod')!;
const mainnet = findNetwork('cardano:mainnet')!;

/** The enterprise address of a private key, as the mnemonic's holder would compute it. */
const addressOf = (key: Bip32PrivateKey.Bip32PrivateKey, networkId: number): string => AddressEras.toBech32(new EnterpriseAddress.EnterpriseAddress({
  networkId,
  paymentCredential: KeyHash.fromVKey(VKey.fromPrivateKey(Bip32PrivateKey.toPrivateKey(key))),
}));

describe('deposit addresses (DP-1)', () => {
  it('derives each index\'s address from the account public key alone, the same one the private key spends from', () => {
    const wallet = createTestDepositWallet();
    const derive = createDepositAddressDeriver({ accountPublicKey: wallet.accountPublicKey, network: preprod });

    for (const index of [0, 1, 42])
      expect(derive(index)).toBe(addressOf(wallet.privateKeyAt(index), 0));
    expect(derive(0)).not.toBe(derive(1));
    expect(derive(7)).toMatch(/^addr_test1v/);
  });

  it('makes mainnet addresses for cardano:mainnet', () => {
    const wallet = createTestDepositWallet();

    expect(createDepositAddressDeriver({ accountPublicKey: wallet.accountPublicKey, network: mainnet })(3)).toBe(addressOf(wallet.privateKeyAt(3), 1));
    expect(createDepositAddressDeriver({ accountPublicKey: wallet.accountPublicKey, network: mainnet })(3)).toMatch(/^addr1v/);
  });

  it('refuses a key that isn\'t 128 hex characters, a network that isn\'t Cardano, and an index out of range', () => {
    const wallet = createTestDepositWallet();

    expect(() => createDepositAddressDeriver({ accountPublicKey: 'xpub-not-hex', network: preprod })).toThrow(DepositKeyError);
    expect(() => createDepositAddressDeriver({ accountPublicKey: wallet.accountPublicKey.slice(2), network: preprod })).toThrow(DepositKeyError);
    expect(() => createDepositAddressDeriver({ accountPublicKey: wallet.accountPublicKey, network: findNetwork('eip155:8453')! })).toThrow(DepositKeyError);
    const derive = createDepositAddressDeriver({ accountPublicKey: wallet.accountPublicKey, network: preprod });
    expect(() => derive(-1)).toThrow(RangeError);
    expect(() => derive(2 ** 31)).toThrow(RangeError);
  });
});

describe('deposit amounts (DP-4)', () => {
  it('credits a 6-decimal stablecoin 1:1 in micro-USD, rounding other decimals down', () => {
    expect(depositUsdAmount(25_000_000n, 6)).toBe(25_000_000n);
    expect(depositUsdAmount(1_234_567_890n, 9)).toBe(1_234_567n);
    expect(depositUsdAmount(5n, 2)).toBe(50_000n);
  });

  it('reads an asset of the registry as Blockfrost\'s unit: the policy ID and asset name, joined', () => {
    expect(blockfrostUnit({ address: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d' }))
      .toBe('c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d');
  });
});
