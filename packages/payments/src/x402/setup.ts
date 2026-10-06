import { withTimeout, type Clock, type MicroUsd, type NetworkId } from '@servicerouter/common';
import { facilitatorFee, type CdpAuth, type PlatformConfig } from '@servicerouter/core';
import { x402ResourceServer } from '@x402/core/server';
import type { Network, SchemeNetworkServer } from '@x402/core/types';
import { ExactCardanoScheme } from '@x402/cardano/exact/server';
import { findDefaultAsset } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';

import { bazaarResourceServerExtension } from './bazaar.js';
import { createCdpRequestSigner, type CdpApiKey } from './cdp.js';
import { createFacilitator, type Facilitator } from './facilitator.js';

// AR12: a Cardano payment is settled at block inclusion. The policy is ours, in every quote (CF-5, PR-8)
export const cardanoL1Confirmations = 0;
// PR-8: address to address. Masumi escrow and script locks aren't offered
export const cardanoTransferMethod = 'default';

/** An asset the x402 rail offers (PC-6), with the scheme's `extra`: the EIP-712 domain on EVM, the transfer and confirmation policy on Cardano. */
export interface X402Asset {
  readonly name: string;
  readonly network: NetworkId;
  readonly address: string;
  readonly decimals: number;
  readonly minPrice: MicroUsd;
  readonly payTo: string;
  readonly extra: Readonly<Record<string, unknown>>;
}

/** The x402 rail's view of the platform: the resource server, the enabled facilitators, and the assets offered. */
export interface X402Setup {
  readonly server: x402ResourceServer;
  readonly facilitators: readonly Facilitator[];
  readonly assets: readonly X402Asset[];
  /** The enabled facilitator that serves a network, such as for the settlement follow-up. */
  facilitatorFor(network: string): Facilitator | undefined;
  /** The registry name of an asset on a network, such as `base-usdc`, from every asset in platform config. */
  assetName(network: string, address: string): string | undefined;
  /** The flat fee of the facilitator that settles on a network (P-2), taken from the seller's earnings. 0 for none. */
  feePerPayment(network: string): MicroUsd;
}

export interface FacilitatorsOptions {
  readonly config: PlatformConfig;
  // The CDP API key a facilitator's auth names, read with readSecret (PC-3)
  readonly cdpApiKey: (auth: CdpAuth) => CdpApiKey;
  readonly clock: Clock;
  // `/supported` and `/verify`. Default: platform config's connect timeout.
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** The enabled facilitators of platform config, as HTTP clients (PR-6). CDP signs each request. */
export const createFacilitators = ({ config, cdpApiKey, clock, requestTimeoutMs = config.timeouts.connectMs, fetch }: FacilitatorsOptions): Facilitator[] =>
  config.facilitators.filter(facilitator => facilitator.enabled).map(facilitator => createFacilitator({
    name: facilitator.name,
    url: facilitator.url,
    signer: facilitator.auth ? createCdpRequestSigner({ apiKey: cdpApiKey(facilitator.auth), clock }) : undefined,
    requestTimeoutMs,
    settleTimeoutMs: config.timeouts.settleMs,
    ...(fetch ? { fetch } : {}),
  }));

export interface X402SetupOptions {
  readonly config: PlatformConfig;
  // From `createFacilitators`, or fakes in tests. Matched to platform config by name.
  readonly facilitators: readonly Facilitator[];
  // How long the startup check may take
  readonly timeoutMs: number;
}

const sameAddress = (namespace: string, left: string, right: string): boolean =>
  namespace === 'eip155' ? left.toLowerCase() === right.toLowerCase() : left === right;

/** The enabled facilitator that serves each network, from platform config and the clients by name. */
export const createFacilitatorLookup = (config: PlatformConfig, facilitators: readonly Facilitator[]): ((network: string) => Facilitator | undefined) => {
  const byName = new Map(facilitators.map(facilitator => [facilitator.name, facilitator]));
  const byNetwork = new Map<string, Facilitator>();
  for (const { name, networks } of config.facilitators.filter(facilitator => facilitator.enabled)) {
    const client = byName.get(name);
    if (!client)
      throw new Error(`No client for the ${name} facilitator`);
    for (const network of networks)
      byNetwork.set(network, client);
  }

  return network => byNetwork.get(network);
};

/** The registry name of an asset on a network, such as `base-usdc`, from every asset in platform config. */
export const createAssetLookup = (config: PlatformConfig) => (network: string, address: string): string | undefined =>
  config.assets.find(asset => asset.network.id === network && sameAddress(asset.network.namespace, asset.address, address))?.name;

export interface CheckFacilitatorsOptions {
  readonly config: PlatformConfig;
  readonly facilitators: readonly Facilitator[];
  readonly timeoutMs: number;
}

/**
 * Every enabled facilitator answers `/supported` within the timeout, and lists `exact` (x402 v2) on
 * each network platform config gives it. Otherwise this throws, so an app that pays or settles
 * through them fails fast (PR-6).
 */
export const checkFacilitators = async ({ config, facilitators, timeoutMs }: CheckFacilitatorsOptions): Promise<void> => {
  const networksOf = new Map(config.facilitators.map(facilitator => [facilitator.name, facilitator.networks]));
  await withTimeout(async () => {
    await Promise.all(facilitators.map(async facilitator => {
      let supported;
      try {
        supported = await facilitator.getSupported();
      }
      catch (error) {
        throw new Error(`The ${facilitator.name} facilitator's /supported failed`, { cause: error });
      }
      const missing = (networksOf.get(facilitator.name) ?? []).filter(network =>
        !supported.kinds.some(kind => kind.x402Version === 2 && kind.scheme === 'exact' && kind.network === network));
      if (missing.length > 0)
        throw new Error(`The ${facilitator.name} facilitator's /supported doesn't list exact on ${missing.join(', ')}`);
    }));
  }, { timeoutMs });
};

// The SDK's `exact` scheme for a network's namespace
const schemes: Readonly<Record<string, () => SchemeNetworkServer>> = {
  eip155: () => new ExactEvmScheme(),
  solana: () => new ExactSvmScheme(),
  cardano: () => new ExactCardanoScheme(),
};

/** The scheme's `extra` an asset's quotes carry. */
const extraFor = (asset: PlatformConfig['assets'][number]): Record<string, unknown> => {
  const { id, namespace } = asset.network;
  if (namespace === 'cardano')
    return { assetTransferMethod: cardanoTransferMethod, confirmationPolicy: { l1Confirmations: cardanoL1Confirmations } };
  if (namespace !== 'eip155')
    return {};

  const known = findDefaultAsset(asset.address, id);
  if (!known)
    throw new Error(`The asset ${asset.name} has no EIP-712 domain in the x402 SDK's defaults, so buyers can't sign for it`);

  return { name: known.name, version: known.version };
};

/**
 * Prepares the x402 rail (PR-5, PR-6). Every enabled facilitator must answer `/supported` within
 * the timeout, or this throws: the proxy fails fast. Then the resource server loads what each
 * supports, such as the Solana fee payer and the Cardano confirmation range. Offered: the assets on
 * Base, Solana, and Cardano networks whose facilitator is enabled. An EVM asset needs its EIP-712
 * domain from the SDK's defaults.
 */
export const initializeX402 = async ({ config, facilitators, timeoutMs }: X402SetupOptions): Promise<X402Setup> => {
  const facilitatorFor = createFacilitatorLookup(config, facilitators);
  await checkFacilitators({ config, facilitators, timeoutMs });

  // PR-7: the x402 Bazaar extension adds each call's method and path parameters to its declaration
  const server = new x402ResourceServer([...facilitators]).registerExtension(bazaarResourceServerExtension);
  const assets: X402Asset[] = [];
  const namespaces = new Map<string, string>();
  for (const asset of config.assets) {
    const { id, namespace } = asset.network;
    if (!facilitatorFor(id) || !(namespace in schemes) || asset.network.chain === 'tempo')
      continue;

    assets.push({ name: asset.name, network: id, address: asset.address, decimals: asset.decimals, minPrice: asset.minPrice, payTo: asset.payTo, extra: extraFor(asset) });
    namespaces.set(id, namespace);
  }
  for (const [network, namespace] of namespaces)
    server.register(network as Network, schemes[namespace]!());
  await withTimeout(() => server.initialize(), { timeoutMs });

  return {
    server,
    facilitators,
    assets,
    facilitatorFor,
    assetName: createAssetLookup(config),
    feePerPayment: network => facilitatorFee(config, network),
  };
};
