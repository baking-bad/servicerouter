import type { Challenge, Receipt } from 'mppx';
import { Mppx, tempo } from 'mppx/server';
import type { Address, Client } from 'viem';

import type { MicroUsd, Secret } from '@servicerouter/common';
import type { PlatformConfig } from '@servicerouter/core';

import type { ReplayStore } from '../ports.js';
import { createTempoRpc, type TempoRpc } from './rpc.js';

/** A Tempo asset MPP offers (PC-6): a TIP-20 USD stablecoin on `mpp.network`, paid to the recipient. */
export interface MppAsset {
  readonly name: string;
  readonly address: Address;
  readonly decimals: number;
  readonly minPrice: MicroUsd;
}

/** The options a credential is checked against: the charge request and the URL it is bound to. */
export interface MppCredentialOptions {
  readonly request: Readonly<Record<string, unknown>>;
  readonly scope: string;
}

/** The part of an `mppx` server the rail uses (`Mppx.create`). */
export interface MppxServer {
  readonly challenge: {
    readonly tempo: {
      readonly charge: (options: Readonly<Record<string, unknown>> & { readonly description?: string; readonly scope?: string }) => Promise<Challenge.Challenge>;
    };
  };
  /** Checks a credential against the request without moving anything. Throws a PaymentError when refused. */
  validateCredential(credential: string, options: MppCredentialOptions): Promise<unknown>;
  /** Validates again, claims the transaction in the replay store, broadcasts it, and waits for its receipt. */
  broadcastCredential(credential: string, options: MppCredentialOptions): Promise<Receipt.Receipt>;
}

// One `mppx` server: the Tempo charge in pull mode, one method per asset, with its challenges bound to
// our realm (PX-10)
const createServer = ({ assets, chainId, recipient, store, client, secretKey, realm }: {
  readonly assets: readonly MppAsset[];
  readonly chainId: number;
  readonly recipient: Address;
  readonly store: ReplayStore;
  readonly client: Client;
  readonly secretKey: string;
  readonly realm: string;
}): MppxServer => {
  const server = Mppx.create({
    methods: assets.map(asset => tempo.charge({
      currencies: [asset.address],
      decimals: asset.decimals,
      recipient,
      chainId,
      store,
      getClient: () => client,
      // The buyer signs, we broadcast after a billable answer (PR-9)
      supportedModes: ['pull'],
      // No fee sponsorship: the proxy holds no key that moves funds (rule 6)
      sponsorBudget: false,
      waitForConfirmation: true,
    })),
    secretKey,
    realm,
  });

  return {
    // Built from a list of methods, so its type doesn't name `tempo.charge`, which every asset adds
    challenge: server.challenge as unknown as MppxServer['challenge'],
    validateCredential: (credential, options) => server.validateCredential(credential, options),
    broadcastCredential: (credential, options) => server.broadcastCredential(credential, options),
  };
};

/** The MPP rail's view of the platform (PR-9). */
export interface MppSetup {
  // mpp.network, CAIP-2, such as eip155:42431
  readonly network: string;
  readonly chainId: number;
  readonly recipient: Address;
  readonly assets: readonly MppAsset[];
  // Checks credentials before forwarding, its RPC calls within the connect timeout
  readonly validator: MppxServer;
  // Broadcasts after a billable answer, its RPC calls within the settle timeout (PR-12)
  readonly broadcaster: MppxServer;
  readonly store: ReplayStore;
  readonly rpc: TempoRpc;
  // Readiness and startup: the RPC answers with mpp.network's chain ID
  check(timeoutMs: number): Promise<void>;
}

export interface MppSetupOptions {
  readonly config: PlatformConfig;
  // MPP_SECRET_KEY: the challenges' HMAC key, at least 32 bytes, the same on every replica
  readonly secretKey: Secret;
  // Shared by every proxy replica (section 5: `mpp:*`)
  readonly store: ReplayStore;
  // How long the startup check may take (PR-6's 10 s)
  readonly timeoutMs: number;
  // Default: mpp.rpcUrl, else the chain's public RPC
  readonly rpcUrl?: string;
}

/**
 * Prepares the MPP rail (PR-9). The Tempo RPC must answer with `mpp.network`'s chain ID within the
 * timeout, or this throws and the proxy doesn't start. Offered: the asset registry's Tempo assets on
 * `mpp.network`. The realm is the canonical pay host, never a request's `Host` (PX-10).
 */
export const initializeMpp = async ({ config, secretKey, store, timeoutMs, rpcUrl }: MppSetupOptions): Promise<MppSetup> => {
  const { network, recipient } = config.mpp;
  const assets = config.assets
    .filter(asset => asset.network.id === network.id)
    .map(asset => ({ name: asset.name, address: asset.address as Address, decimals: asset.decimals, minPrice: asset.minPrice }));
  if (assets.length === 0)
    throw new Error(`MPP is on, but no asset is on mpp.network (${network.id}). Add a Tempo asset, or set mpp.enabled: false`);

  const rpc = createTempoRpc({ network, url: rpcUrl ?? config.mpp.rpcUrl });
  await rpc.check(timeoutMs);

  const chainId = rpc.chain.id;
  const common = { assets, chainId, recipient: recipient as Address, store, secretKey: secretKey.expose(), realm: new URL(config.urls.pay).host };

  return {
    network: network.id,
    chainId,
    recipient: recipient as Address,
    assets,
    validator: createServer({ ...common, client: rpc.client(config.timeouts.connectMs) }),
    broadcaster: createServer({ ...common, client: rpc.client(config.timeouts.settleMs) }),
    store,
    rpc,
    check: ms => rpc.check(ms),
  };
};
