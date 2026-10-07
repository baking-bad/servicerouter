import { readSecret, Secret, type SecretEnvironment } from '@servicerouter/common';

import type { PlatformConfig } from './platform/config.js';

// Solana's public RPCs, by network. They're rate limited: production sets SOLANA_RPC_URL.
export const publicSolanaRpcUrls: Readonly<Record<string, string>> = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'https://api.mainnet-beta.solana.com',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'https://api.devnet.solana.com',
};

export interface SolanaRpc {
  // The URL may carry a key in its path, as NOWNodes' does (`https://sol.nownodes.io/<key>`)
  readonly url: Secret;
  // For logs: never the path or query
  readonly host: string;
  // No SOLANA_RPC_URL: the network's public RPC
  readonly public: boolean;
}

/**
 * The Solana RPC for the config's Solana network: `SOLANA_RPC_URL`, else the network's public RPC.
 * Undefined when the config has no Solana asset. An invalid URL throws without echoing it, since it may
 * hold a key.
 */
export const readSolanaRpc = (env: SecretEnvironment, config: Pick<PlatformConfig, 'assets'>): SolanaRpc | undefined => {
  const network = config.assets.find(asset => asset.network.namespace === 'solana')?.network.id;
  if (network === undefined)
    return undefined;
  const url = env['SOLANA_RPC_URL']?.trim() ? readSecret('SOLANA_RPC_URL', env) : undefined;
  const value = url?.expose() ?? publicSolanaRpcUrls[network];
  let parsed: URL | undefined;
  try {
    parsed = value === undefined ? undefined : new URL(value);
  }
  catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:'))
    throw new Error('SOLANA_RPC_URL is not an HTTP(S) URL');

  return { url: url ?? Secret.from(value!), host: parsed.host, public: url === undefined };
};
