import { createPublicClient, erc20Abi, getAddress, http, type PublicClient } from 'viem';

import { isRecord, ServiceRouterError, type Secret } from '@servicerouter/common';
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

/** The Solana RPC didn't answer, or answered something unexpected. The message names the call, never the RPC's URL. */
export class SolanaRpcError extends ServiceRouterError {
  readonly code = 'solana_rpc_unavailable';
}

// Where `jsonParsed` puts a token account's atomic amount, as a string
const amountPath = ['account', 'data', 'parsed', 'info', 'tokenAmount', 'amount'] as const;

const atomicAmountOf = (account: unknown): bigint => {
  const amount = amountPath.reduce<unknown>((value, key) => isRecord(value) ? value[key] : undefined, account);
  if (typeof amount !== 'string' || !/^\d{1,30}$/.test(amount))
    throw new SolanaRpcError('The Solana RPC answered a token account without an amount');

  return BigInt(amount);
};

/**
 * Solana balances through its JSON-RPC (TR-3): the sum of the owner's token accounts for the asset's
 * mint, from `getTokenAccountsByOwner`. An owner without one holds `0n`. The URL may carry a key in its
 * path, as NOWNodes' does, so it stays in `Secret` and out of every error.
 */
export const createSolanaBalanceReader = ({ rpcUrl, timeoutMs, fetch = globalThis.fetch }: {
  // SOLANA_RPC_URL, or the network's public RPC
  readonly rpcUrl: Secret;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}): Required<BalanceReader> => {
  const tokenAccounts = async ({ address, asset }: { readonly address: string; readonly asset: Asset }): Promise<readonly bigint[]> => {
    const what = 'getTokenAccountsByOwner';
    let response: Response;
    try {
      response = await fetch(rpcUrl.expose(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: what, params: [address, { mint: asset.address }, { encoding: 'jsonParsed', commitment: 'confirmed' }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    catch (error) {
      throw new SolanaRpcError(`The Solana RPC didn't answer ${what}`, { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SolanaRpcError(`The Solana RPC answered ${what} with status ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    }
    catch {
      throw new SolanaRpcError(`The Solana RPC answered ${what} with invalid JSON`);
    }
    if (isRecord(body) && isRecord(body['error']))
      throw new SolanaRpcError(`The Solana RPC refused ${what}: ${typeof body['error']['code'] === 'number' ? body['error']['code'] : 'no code'}`);
    const accounts = isRecord(body) && isRecord(body['result']) ? body['result']['value'] : undefined;
    if (!Array.isArray(accounts))
      throw new SolanaRpcError(`The Solana RPC answered ${what} without a list of accounts`);

    return accounts.map(atomicAmountOf);
  };

  return {
    balance: async input => (await tokenAccounts(input)).reduce((sum, amount) => sum + amount, 0n),
    hasTokenAccount: async input => (await tokenAccounts(input)).length > 0,
  };
};

/** Picks the reader for an asset's chain. Undefined: no reader was given for that chain. */
export const readerFor = (readers: { readonly cardano?: BalanceReader; readonly evm?: BalanceReader; readonly solana?: BalanceReader }) => (asset: Asset): BalanceReader | undefined =>
  asset.network.namespace === 'cardano' ? readers.cardano : asset.network.namespace === 'eip155' ? readers.evm : asset.network.namespace === 'solana' ? readers.solana : undefined;
