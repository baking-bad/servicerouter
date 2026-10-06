#!/usr/bin/env node
// Prints a new HD wallet for buyers' deposit addresses (DP-1): its mnemonic, to keep offline, and the
// account public key of m/1852'/1815'/0', which the Platform API gets as DEPOSIT_ACCOUNT_PUBLIC_KEY.
// Each account's deposit address is the enterprise address of m/1852'/1815'/0'/0/<index>, so any
// Cardano wallet restored from the mnemonic spends from it. Never commit the mnemonic.
//
// Usage:
//   node scripts/deposit-keygen.mjs [mainnet|preprod]
//
// Needs Node 24+ and `npm ci` (the Evolution SDK and @scure/bip39 from node_modules).

import { randomBytes } from 'node:crypto';

import * as AddressEras from '@evolution-sdk/evolution/AddressEras';
import * as Bip32PrivateKey from '@evolution-sdk/evolution/Bip32PrivateKey';
import * as Bip32PublicKey from '@evolution-sdk/evolution/Bip32PublicKey';
import * as EnterpriseAddress from '@evolution-sdk/evolution/EnterpriseAddress';
import * as KeyHash from '@evolution-sdk/evolution/KeyHash';
import * as VKey from '@evolution-sdk/evolution/VKey';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const network = process.argv[2] ?? 'mainnet';
if (network !== 'mainnet' && network !== 'preprod') {
  process.stderr.write('Usage: node scripts/deposit-keygen.mjs [mainnet|preprod]\n');
  process.exit(2);
}

// 24 words
const entropy = randomBytes(32);
const harden = Bip32PrivateKey.CardanoPath.harden;
const account = Bip32PrivateKey.derive(Bip32PrivateKey.fromBip39Entropy(entropy), [harden(1852), harden(1815), harden(0)]);
const accountPublicKey = Bip32PrivateKey.toPublicKey(account);
const first = Bip32PublicKey.deriveChild(Bip32PublicKey.deriveChild(accountPublicKey, 0), 0);
const firstAddress = AddressEras.toBech32(new EnterpriseAddress.EnterpriseAddress({
  networkId: network === 'mainnet' ? 1 : 0,
  paymentCredential: KeyHash.fromVKey(VKey.fromBytes(Bip32PublicKey.publicKey(first))),
}));

const words = entropyToMnemonic(entropy, wordlist).split(' ');
// Numbered, four to a line: a copied line can't run two words together unnoticed
const numbered = Array.from({ length: words.length / 4 }, (_, row) =>
  words.slice(row * 4, row * 4 + 4).map((word, column) => `${String(row * 4 + column + 1).padStart(2)}. ${word.padEnd(10)}`).join(' ').trimEnd());

process.stdout.write([
  `# Mnemonic, ${words.length} words: keep it offline. Whoever holds it spends every deposit`,
  words.join(' '),
  '',
  '# The same words, numbered, to write down and check',
  ...numbered,
  '',
  '# DEPOSIT_ACCOUNT_PUBLIC_KEY: for the Platform API. Public, but keep it with the stack\'s settings',
  Bip32PublicKey.toHex(accountPublicKey),
  '',
  `# The first deposit address (index 0) on ${network}, to check a wallet restored from the mnemonic`,
  firstAddress,
  '',
].join('\n'));
entropy.fill(0);
