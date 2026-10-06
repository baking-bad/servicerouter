import { isRecord, type MicroUsd } from '@servicerouter/common';

import { isValidAddress } from '../addresses.js';
import type { Asset, PlatformConfig } from '../platform/config.js';

/**
 * Why the platform won't pay a routed target's MPP challenge (RT-4, SG-3), as a code for the logs
 * (L-5, L-6). Push mode, splits, and an automatic swap are out of the MVP (T27).
 */
export type TempoChargeRefusal = 'not_tempo_charge' | 'wrong_chain' | 'push_only' | 'splits' | 'unsupported_currency' | 'invalid_amount';

/** The parts of an MPP challenge the check reads: `mppx`'s `Challenge`, with its request as sent. */
export interface MppChallengeLike {
  readonly method: string;
  readonly intent: string;
  readonly request: Readonly<Record<string, unknown>>;
}

/** A Tempo charge the platform pays: an asset of the registry on `mpp.network`, and its price. */
export interface TempoCharge {
  readonly asset: Asset;
  readonly atomicAmount: bigint;
  // Rounded up to the micro-USD: the platform never quotes less than the target asks
  readonly price: MicroUsd;
  readonly recipient: string;
  // The target pays our transaction's fee (`feePayer`)
  readonly sponsored: boolean;
}

/** `mpp.network`'s chain ID, such as 4217 for `eip155:4217`. */
export const mppChainId = (config: PlatformConfig): number => Number(config.mpp.network.id.split(':')[1]);

const priceOf = (atomic: bigint, decimals: number): MicroUsd => {
  const scale = 10n ** BigInt(Math.abs(decimals - 6));

  return (decimals >= 6 ? (atomic + scale - 1n) / scale : atomic * scale) as MicroUsd;
};

/**
 * Checks a target's MPP challenge against what the platform pays (RT-4, SG-3): a Tempo charge on
 * `mpp.network`, payable in pull mode, without splits, in an asset of the registry on that network.
 * A challenge without a chain ID is signed on `mpp.network`'s, as `mppx`'s client does with a pinned
 * chain. The proxy checks it to choose an option, and the Signer again before it signs.
 */
export const checkTempoCharge = (
  challenge: MppChallengeLike,
  config: PlatformConfig,
): { readonly charge: TempoCharge; readonly refusal?: undefined } | { readonly charge?: undefined; readonly refusal: TempoChargeRefusal } => {
  const { request } = challenge;
  const recipient = request['recipient'];
  if (challenge.method !== 'tempo' || challenge.intent !== 'charge' || typeof recipient !== 'string' || !isValidAddress(config.mpp.network, recipient))
    return { refusal: 'not_tempo_charge' };
  const details = isRecord(request['methodDetails']) ? request['methodDetails'] : {};
  const chainId = details['chainId'];
  if (chainId !== undefined && chainId !== mppChainId(config))
    return { refusal: 'wrong_chain' };
  // Pull mode: the Signer signs, and the target broadcasts. No modes listed means both.
  const modes = details['supportedModes'];
  if (Array.isArray(modes) && !modes.includes('pull'))
    return { refusal: 'push_only' };
  const splits = details['splits'];
  if (Array.isArray(splits) && splits.length > 0)
    return { refusal: 'splits' };
  const currency = request['currency'];
  const asset = typeof currency === 'string'
    ? config.assets.find(item => item.network.id === config.mpp.network.id && item.address.toLowerCase() === currency.toLowerCase())
    : undefined;
  if (!asset)
    return { refusal: 'unsupported_currency' };
  const amount = request['amount'];
  if (typeof amount !== 'string' || !/^\d{1,30}$/.test(amount) || BigInt(amount) <= 0n)
    return { refusal: 'invalid_amount' };
  const atomicAmount = BigInt(amount);

  return { charge: { asset, atomicAmount, price: priceOf(atomicAmount, asset.decimals), recipient, sponsored: details['feePayer'] === true } };
};
