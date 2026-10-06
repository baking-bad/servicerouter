import { createPublicClient, erc20Abi, getAddress, http, type PublicClient } from 'viem';

import { blockfrostUnit, type Asset, type BalanceReader, type BlockfrostClient } from '@servicerouter/core';

/** Cardano balances through Blockfrost (TR-3): the address's amount of the asset's unit. */
export const createCardanoBalanceReader = (blockfrost: Pick<BlockfrostClient, 'addressAmounts'>): BalanceReader => ({
  balance: async ({ address, asset }) => (await blockfrost.addressAmounts(address)).get(blockfrostUnit(asset)) ?? 0n,
});

/** EVM balances (Base, Tempo) through each network's JSON-RPC (TR-3): the token's `balanceOf`. */
export const createEvmBalanceReader = ({ rpcUrlFor, timeoutMs }: {
  // The RPC of an `eip155:<chain ID>` network, without credentials
  readonly rpcUrlFor: (networkId: string) => string | undefined;
  readonly timeoutMs: number;
}): BalanceReader => {
  const clients = new Map<string, PublicClient>();
  const clientFor = (asset: Asset): PublicClient => {
    const url = rpcUrlFor(asset.network.id);
    if (!url)
      throw new Error(`No RPC for ${asset.network.id}`);
    const client = clients.get(url) ?? createPublicClient({ transport: http(url, { timeout: timeoutMs, retryCount: 0 }) });
    clients.set(url, client);

    return client;
  };

  return {
    balance: ({ address, asset }) => clientFor(asset).readContract({
      address: getAddress(asset.address),
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [getAddress(address)],
    }),
  };
};

/** Picks the reader for an asset's chain. Undefined: the chain has no reader yet, such as Solana (P-6). */
export const readerFor = (readers: { readonly cardano?: BalanceReader; readonly evm?: BalanceReader }) => (asset: Asset): BalanceReader | undefined =>
  asset.network.namespace === 'cardano' ? readers.cardano : asset.network.namespace === 'eip155' ? readers.evm : undefined;
