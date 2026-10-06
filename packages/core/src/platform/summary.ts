import type { PlatformConfig } from './config.js';

/** What every app's startup line says about the platform (L-1). Names, networks, and URLs only. */
export interface PlatformSummary {
  readonly environment: PlatformConfig['environment'];
  readonly urls: PlatformConfig['urls'];
  readonly rails: {
    readonly credits: true;
    // Each enabled facilitator and the networks it serves
    readonly x402: readonly { readonly facilitator: string; readonly networks: readonly string[] }[];
    readonly mpp: { readonly network: string } | false;
  };
  readonly deposits: { readonly network: string; readonly asset: string; readonly confirmations: number } | false;
  readonly payoutAssets: readonly string[];
  readonly fees: { readonly feeBps: number; readonly routingFeeBps: number };
}

/**
 * The platform as the startup line logs it (L-1): the environment, the public URLs, the enabled rails
 * with their networks and facilitators, MPP's network, and whether deposits are on. No secret, key, or
 * address: config holds secrets by name only, and the payout addresses stay out.
 */
export const platformSummary = (config: PlatformConfig): PlatformSummary => ({
  environment: config.environment,
  urls: config.urls,
  rails: {
    credits: true,
    x402: config.facilitators.filter(facilitator => facilitator.enabled).map(facilitator => ({ facilitator: facilitator.name, networks: facilitator.networks })),
    mpp: config.mpp.enabled ? { network: config.mpp.network.id } : false,
  },
  deposits: config.deposits
    ? { network: config.deposits.network.id, asset: config.deposits.asset.name, confirmations: config.deposits.confirmations }
    : false,
  payoutAssets: config.payouts.assets,
  fees: { feeBps: config.feeBps, routingFeeBps: config.routingFeeBps },
});
