import * as AddressEras from '@evolution-sdk/evolution/AddressEras';
import * as Bip32PublicKey from '@evolution-sdk/evolution/Bip32PublicKey';
import * as EnterpriseAddress from '@evolution-sdk/evolution/EnterpriseAddress';
import * as KeyHash from '@evolution-sdk/evolution/KeyHash';
import * as VKey from '@evolution-sdk/evolution/VKey';

import { ServiceRouterError } from '@servicerouter/common';

import type { NetworkInfo } from '../networks.js';

/** The deposit account public key is missing or isn't one. */
export class DepositKeyError extends ServiceRouterError {
  readonly code = 'deposit_key_invalid';
}

// The external chain of CIP-1852: m/1852'/1815'/<account>'/0/<index>
const externalRole = 0;
// Soft derivation only: indices below 2^31
export const maxDepositIndex = 0x7f_ff_ff_ff;
const accountKeyPattern = /^[0-9a-f]{128}$/;

/** Derives deposit addresses for an account index (DP-1). */
export type DepositAddressDeriver = (index: number) => string;

/**
 * Deposit addresses from the HD wallet's account public key (DP-1): the extended public key of
 * m/1852'/1815'/0', as 128 hex characters (the key, then the chain code). Each account gets the
 * enterprise address of m/…/0/<index>. Only public derivation: the private key stays offline, and
 * whoever holds the mnemonic spends from the same path.
 */
export const createDepositAddressDeriver = ({ accountPublicKey, network }: {
  readonly accountPublicKey: string;
  readonly network: NetworkInfo;
}): DepositAddressDeriver => {
  const hex = accountPublicKey.trim().toLowerCase();
  if (!accountKeyPattern.test(hex))
    throw new DepositKeyError('The deposit account public key must be 128 hex characters: the key, then the chain code');
  if (network.chain !== 'cardano')
    throw new DepositKeyError(`Deposit addresses are on Cardano, not ${network.title}`);

  let external: Bip32PublicKey.Bip32PublicKey;
  try {
    external = Bip32PublicKey.deriveChild(Bip32PublicKey.fromHex(hex), externalRole);
  }
  catch {
    throw new DepositKeyError('The deposit account public key isn\'t a valid extended public key');
  }
  const networkId = network.testnet ? 0 : 1;

  return index => {
    if (!Number.isInteger(index) || index < 0 || index > maxDepositIndex)
      throw new RangeError(`A deposit index must be an integer from 0 to ${maxDepositIndex}`);

    const child = Bip32PublicKey.deriveChild(external, index);
    const paymentCredential = KeyHash.fromVKey(VKey.fromBytes(Bip32PublicKey.publicKey(child)));

    return AddressEras.toBech32(new EnterpriseAddress.EnterpriseAddress({ networkId, paymentCredential }));
  };
};
