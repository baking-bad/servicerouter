import type { NetworkId } from '@servicerouter/common';

export type NetworkNamespace = 'eip155' | 'solana' | 'cardano';
export type Chain = 'base' | 'solana' | 'cardano' | 'tempo';

export interface NetworkInfo {
  readonly id: NetworkId;
  readonly namespace: NetworkNamespace;
  readonly chain: Chain;
  readonly title: string;
  readonly testnet: boolean;
}

// Every network a deployment may use. Adding one is a product decision, so it's a code change, not a
// config change. IDs match the x402 SDKs (@x402/evm, @x402/svm, @x402/cardano) and viem's Tempo chains.
export const supportedNetworks: readonly NetworkInfo[] = [
  { id: 'eip155:8453', namespace: 'eip155', chain: 'base', title: 'Base', testnet: false },
  { id: 'eip155:84532', namespace: 'eip155', chain: 'base', title: 'Base Sepolia', testnet: true },
  { id: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', namespace: 'solana', chain: 'solana', title: 'Solana', testnet: false },
  { id: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', namespace: 'solana', chain: 'solana', title: 'Solana Devnet', testnet: true },
  { id: 'cardano:mainnet', namespace: 'cardano', chain: 'cardano', title: 'Cardano', testnet: false },
  { id: 'cardano:preprod', namespace: 'cardano', chain: 'cardano', title: 'Cardano Preprod', testnet: true },
  { id: 'eip155:4217', namespace: 'eip155', chain: 'tempo', title: 'Tempo', testnet: false },
  { id: 'eip155:42431', namespace: 'eip155', chain: 'tempo', title: 'Tempo Moderato', testnet: true },
];

export const findNetwork = (id: string): NetworkInfo | undefined => supportedNetworks.find(network => network.id === id);
