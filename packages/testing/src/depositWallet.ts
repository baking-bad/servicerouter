import { randomBytes } from 'node:crypto';

import * as Bip32PrivateKey from '@evolution-sdk/evolution/Bip32PrivateKey';
import * as Bip32PublicKey from '@evolution-sdk/evolution/Bip32PublicKey';

/** An HD wallet made in the test: the account public key the apps get (DP-1), and its private side. */
export interface TestDepositWallet {
  // m/1852'/1815'/0' as 128 hex characters: DEPOSIT_ACCOUNT_PUBLIC_KEY
  readonly accountPublicKey: string;
  /** The private key at m/…/0/<index>, as whoever holds the mnemonic derives it. */
  privateKeyAt(index: number): Bip32PrivateKey.Bip32PrivateKey;
}

const harden = Bip32PrivateKey.CardanoPath.harden;

export const createTestDepositWallet = (): TestDepositWallet => {
  const root = Bip32PrivateKey.fromBip39Entropy(randomBytes(16));
  const account = Bip32PrivateKey.derive(root, [harden(1852), harden(1815), harden(0)]);

  return {
    accountPublicKey: Bip32PublicKey.toHex(Bip32PrivateKey.toPublicKey(account)),
    privateKeyAt: index => Bip32PrivateKey.derive(account, [0, index]),
  };
};
