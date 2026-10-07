import { describe, expect, it } from 'vitest';

import { findNetwork, publicSolanaRpcUrls, readSolanaRpc, type Asset } from '../src/index.js';

const assetOn = (networkId: string) => ({ network: findNetwork(networkId)! }) as Asset;
const mainnet = { assets: [assetOn('eip155:8453'), assetOn('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')] };

describe('the Solana RPC for the treasury and the Signer (TR-3, SG-1, P-6)', () => {
  it('takes SOLANA_RPC_URL as a secret, with a key in its path, and logs only its host', () => {
    const rpc = readSolanaRpc({ SOLANA_RPC_URL: 'https://sol.nownodes.io/nownodes-key-secret' }, mainnet);

    expect(rpc?.url.expose()).toBe('https://sol.nownodes.io/nownodes-key-secret');
    expect(rpc?.host).toBe('sol.nownodes.io');
    expect(rpc?.public).toBe(false);
    expect(JSON.stringify(rpc)).not.toContain('nownodes-key-secret');
  });

  it('falls back to the network\'s public RPC without SOLANA_RPC_URL', () => {
    expect(readSolanaRpc({}, mainnet)).toMatchObject({ host: 'api.mainnet-beta.solana.com', public: true });
    expect(readSolanaRpc({ SOLANA_RPC_URL: ' ' }, { assets: [assetOn('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')] })?.url.expose())
      .toBe(publicSolanaRpcUrls['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1']);
  });

  it('is undefined when the config has no Solana asset', () => {
    expect(readSolanaRpc({ SOLANA_RPC_URL: 'https://sol.nownodes.io/key' }, { assets: [assetOn('eip155:8453')] })).toBeUndefined();
  });

  it.each(['sol.nownodes.io/nownodes-key-secret', 'ftp://sol.nownodes.io/nownodes-key-secret'])('refuses %s without echoing it', value => {
    expect(() => readSolanaRpc({ SOLANA_RPC_URL: value }, mainnet)).toThrow(/^SOLANA_RPC_URL is not an HTTP\(S\) URL$/);
  });
});
