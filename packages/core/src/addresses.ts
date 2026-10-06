import type { NetworkInfo } from './networks.js';

const evmAddressRegExp = /^0x[0-9a-fA-F]{40}$/;
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Canonical form from @x402/cardano: <policy ID>.<asset name>, lowercase hex. ADA itself isn't accepted.
const cardanoAssetRegExp = /^[0-9a-f]{56}\.[0-9a-f]{0,64}$/;

const decodeBase58 = (value: string): Uint8Array | undefined => {
  let number = 0n;
  for (const character of value) {
    const digit = base58Alphabet.indexOf(character);
    if (digit < 0)
      return undefined;
    number = number * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  for (; number > 0n; number >>= 8n)
    bytes.unshift(Number(number & 0xffn));
  for (const character of value) {
    if (character !== '1')
      break;
    bytes.unshift(0);
  }

  return Uint8Array.from(bytes);
};

// A Solana account or mint: 32 bytes in base58
const isSolanaKey = (value: string): boolean =>
  value.length >= 32 && value.length <= 44 && decodeBase58(value)?.length === 32;

const bech32Charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const bech32Generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

const bech32Polymod = (values: readonly number[]): number => {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (const [index, generator] of bech32Generators.entries()) {
      if ((top >> index) & 1)
        checksum ^= generator;
    }
  }

  return checksum;
};

/** Decodes a lowercase bech32 string (BIP-173, without its 90-character limit) and checks its checksum. */
const decodeBech32 = (value: string): { readonly prefix: string; readonly bytes: Uint8Array } | undefined => {
  const separator = value.lastIndexOf('1');
  if (value !== value.toLowerCase() || separator < 1 || value.length - separator - 1 < 6)
    return undefined;

  const prefix = value.slice(0, separator);
  const data: number[] = [];
  for (const character of value.slice(separator + 1)) {
    const digit = bech32Charset.indexOf(character);
    if (digit < 0)
      return undefined;
    data.push(digit);
  }

  const expandedPrefix = [...prefix].map(character => character.charCodeAt(0) >> 5)
    .concat(0, [...prefix].map(character => character.charCodeAt(0) & 31));
  if (bech32Polymod([...expandedPrefix, ...data]) !== 1)
    return undefined;

  // 5-bit groups to bytes. Leftover padding bits must be zero.
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const digit of data.slice(0, -6)) {
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (accumulator & ((1 << bits) - 1)) !== 0)
    return undefined;

  return { prefix, bytes: Uint8Array.from(bytes) };
};

/**
 * A Shelley payment address (CIP-19) on the given network: bech32 with a valid checksum, the `addr`
 * or `addr_test` prefix, and a header whose network ID matches. Stake and Byron addresses aren't
 * payment addresses here.
 */
const isCardanoAddress = (value: string, testnet: boolean): boolean => {
  const decoded = decodeBech32(value);
  const header = decoded?.bytes[0];
  if (!decoded || header === undefined || decoded.prefix !== (testnet ? 'addr_test' : 'addr'))
    return false;

  const type = header >> 4;
  const networkId = header & 0x0f;
  if (networkId !== (testnet ? 0 : 1))
    return false;

  const length = decoded.bytes.length;
  // Base: two 28-byte hashes. Pointer: one hash and a variable-length pointer. Enterprise: one hash.
  return type <= 3
    ? length === 57
    : type <= 5
      ? length >= 32
      : type <= 7 && length === 29;
};

/** Whether `address` can receive funds on `network`. EVM and Solana checks are lexical only. */
export const isValidAddress = (network: NetworkInfo, address: string): boolean => {
  switch (network.namespace) {
    case 'eip155': return evmAddressRegExp.test(address);
    case 'solana': return isSolanaKey(address);
    case 'cardano': return isCardanoAddress(address, network.testnet);
  }
};

/** Whether `asset` identifies a token on `network`: an ERC-20 contract, a Solana mint, or a Cardano native asset. */
export const isValidAssetAddress = (network: NetworkInfo, asset: string): boolean => {
  switch (network.namespace) {
    case 'eip155': return evmAddressRegExp.test(asset);
    case 'solana': return isSolanaKey(asset);
    case 'cardano': return cardanoAssetRegExp.test(asset);
  }
};
