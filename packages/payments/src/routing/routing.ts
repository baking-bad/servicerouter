import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { Challenge, Receipt } from 'mppx';

import { isRecord, ServiceRouterError, type MicroUsd } from '@servicerouter/common';
import { checkTempoCharge, findNetwork, type Asset, type PlatformConfig, type TempoChargeRefusal } from '@servicerouter/core';

/** RT-1: the link isn't `/<host>/<path>` with a DNS host. */
export class InvalidTargetError extends ServiceRouterError {
  readonly code = 'invalid_target';
}

/** RT-2: a host the platform doesn't route to. */
export class HostNotAllowedError extends ServiceRouterError {
  readonly code = 'host_not_allowed';

  constructor(message = 'Service Router doesn\'t route payments to this host') {
    super(message);
  }
}

/** RT-3: the target answered without a 402, so there's nothing to pay. */
export class NotPayableError extends ServiceRouterError {
  readonly code = 'not_payable';

  constructor() {
    super('The target didn\'t ask for a payment: Service Router routes paid calls only');
  }
}

/** RT-4: no option of the target's 402 is one the platform pays. */
export class UnsupportedPaymentError extends ServiceRouterError {
  readonly code = 'unsupported_payment';

  constructor() {
    super('The target asks for no payment Service Router can make');
  }
}

/** RT-8: the target asked more on the paid retry than it quoted. */
export class QuoteExceededError extends ServiceRouterError {
  readonly code = 'quote_exceeded';

  constructor() {
    super('The target asked for more than its quoted price: nothing was paid');
  }
}

/** A routed link's target (RT-1). */
export interface RoutingTarget {
  // Lowercase, with the port when one was given
  readonly host: string;
  // The hostname alone, for policy checks
  readonly hostname: string;
  // Starts with `/`, without the query
  readonly path: string;
  // With its `?`, or empty
  readonly search: string;
  // Always HTTPS
  readonly url: string;
}

const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const ipv4Pattern = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Parses `/<host>/<path>?<query>` (RT-1): the host has at least one dot and an optional port, and
 * isn't an IP address. The target is `https://<host>/<path>?<query>`.
 */
export const parseRoutingTarget = (pathAndQuery: string): RoutingTarget => {
  const queryAt = pathAndQuery.indexOf('?');
  const rawPath = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
  const search = queryAt === -1 ? '' : pathAndQuery.slice(queryAt);
  const [, rawHost = '', ...rest] = rawPath.split('/');
  const host = rawHost.toLowerCase();
  const [hostname = '', port] = host.split(':');
  if (port !== undefined && !/^\d{1,5}$/.test(port))
    throw new InvalidTargetError('The target\'s port must be a number');
  if (ipv4Pattern.test(hostname) || hostname.startsWith('['))
    throw new InvalidTargetError('The target must be a host name, not an IP address');
  if (!hostnamePattern.test(hostname))
    throw new InvalidTargetError('The link must be the target URL without https://, such as /api.example.com/v1/pools');
  const path = `/${rest.join('/')}`;

  return { host, hostname, path, search, url: `https://${host}${path}${search}` };
};

type ResponseHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * What the target's 402 asks for (RT-3): x402 options, from the v2 header or the v1 body, and MPP
 * challenges, from `WWW-Authenticate: Payment`. A target may offer both.
 */
export interface TargetChallenge {
  // 0 when the target offers no x402 option
  readonly x402Version: number;
  readonly accepts: readonly PaymentRequirements[];
  // The v2 resource, passed back when paying
  readonly resource: unknown;
  // Each kept whole, with its expiry and its body digest when it binds one: the credential echoes it
  readonly mpp: readonly Challenge.Challenge[];
}

const x402Of = (headers: ResponseHeaders, body: Uint8Array): Pick<TargetChallenge, 'x402Version' | 'accepts' | 'resource'> | undefined => {
  const header = headers['payment-required'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string' && value !== '') {
    try {
      const required = decodePaymentRequiredHeader(value);

      return { x402Version: required.x402Version, accepts: required.accepts, resource: required.resource };
    }
    catch {
      return undefined;
    }
  }
  try {
    const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
    if (isRecord(parsed) && typeof parsed['x402Version'] === 'number' && Array.isArray(parsed['accepts']))
      return { x402Version: parsed['x402Version'], accepts: parsed['accepts'] as PaymentRequirements[], resource: parsed['resource'] };
  }
  catch {
    // Not JSON: no v1 challenge
  }

  return undefined;
};

// Every `Payment` challenge of `WWW-Authenticate`, in one header or several. A header that doesn't parse is skipped.
const mppOf = (headers: ResponseHeaders): Challenge.Challenge[] => {
  const header = headers['www-authenticate'];
  const values = (Array.isArray(header) ? header : [header]).filter((value): value is string => typeof value === 'string' && value !== '');
  const challenges: Challenge.Challenge[] = [];
  for (const value of values) {
    try {
      challenges.push(...Challenge.deserializeList(value));
    }
    catch {
      // Another scheme, or a malformed challenge: nothing to pay with it
    }
  }

  return challenges;
};

/**
 * Reads what a target's 402 asks for (RT-3): the x402 `PAYMENT-REQUIRED` header (v2) or JSON body
 * (v1), and the MPP `WWW-Authenticate: Payment` challenges. Undefined when it holds neither.
 */
export const parseTargetChallenge = (headers: ResponseHeaders, body: Uint8Array): TargetChallenge | undefined => {
  const x402 = x402Of(headers, body);
  const mpp = mppOf(headers);
  if (!x402 && mpp.length === 0)
    return undefined;

  return { x402Version: x402?.x402Version ?? 0, accepts: x402?.accepts ?? [], resource: x402?.resource, mpp };
};

/** The option the platform pays, with its asset and its price in micro-USD (RT-4). */
export type ChosenOption = {
  readonly asset: Asset;
  readonly atomicAmount: bigint;
  readonly price: MicroUsd;
} & ({
  readonly protocol: 'x402';
  readonly requirement: PaymentRequirements;
} | {
  readonly protocol: 'mpp';
  // The challenge as the target sent it, for the Signer (SG-2)
  readonly challenge: string;
  // When the challenge expires, if it says
  readonly expires: string | undefined;
  // The challenge binds the request body: its quote can't serve another body
  readonly bindsBody: boolean;
});

// The chains the Signer holds wallets on (SG-1), by protocol: x402 on Base, MPP on Tempo. Solana joins later (P-6).
export const routableChains = { x402: ['base'], mpp: ['tempo'] } as const;

/** Why the platform won't pay an MPP challenge: the Tempo charge's check (RT-4), or its expiry. */
export type MppRefusal = TempoChargeRefusal | 'expired';

const checkMpp = (challenge: Challenge.Challenge, config: PlatformConfig, now: Date): ReturnType<typeof checkTempoCharge> | { readonly charge?: undefined; readonly refusal: 'expired' } => {
  const checked = checkTempoCharge(challenge, config);
  if (checked.refusal !== undefined)
    return checked;
  const expires = challenge.expires === undefined ? Number.NaN : Date.parse(challenge.expires);

  return expires <= now.getTime() ? { refusal: 'expired' } : checked;
};

/** Why the platform pays each MPP challenge it doesn't, one reason each, for the log (L-5). */
export const mppRefusals = (challenge: TargetChallenge, config: PlatformConfig, now: Date): readonly MppRefusal[] =>
  challenge.mpp.flatMap(item => {
    const { refusal } = checkMpp(item, config, now);

    return refusal === undefined ? [] : [refusal];
  });

const atomicOf = (requirement: PaymentRequirements): bigint | undefined => {
  const amount = (requirement as { amount?: unknown; maxAmountRequired?: unknown }).amount ?? (requirement as { maxAmountRequired?: unknown }).maxAmountRequired;

  return typeof amount === 'string' && /^\d{1,30}$/.test(amount) ? BigInt(amount) : undefined;
};

// Rounded up: the platform never quotes less than the target asks
const priceOf = (atomic: bigint, decimals: number): MicroUsd =>
  (decimals >= 6 ? (atomic + 10n ** BigInt(decimals - 6) - 1n) / 10n ** BigInt(decimals - 6) : atomic * 10n ** BigInt(6 - decimals)) as MicroUsd;

// On a tie, x402 on Base: nothing moves until the target settles it, and its transaction costs us no fee
const protocolOrder = { x402: 0, mpp: 1 } as const;

/**
 * Picks the cheapest option the platform pays (RT-4). On a tie, x402 on Base.
 * - x402: `exact`, on Base, in an asset of the registry pegged to USD, and not a Circle Gateway
 *   nanopayment (AR16);
 * - MPP: a Tempo charge on `mpp.network` in pull mode, without splits, in an asset of the registry on
 *   that network, and not expired.
 */
export const chooseOption = (challenge: TargetChallenge, config: PlatformConfig, now: Date): ChosenOption | undefined => {
  const candidates: ChosenOption[] = [];
  for (const requirement of challenge.accepts) {
    if (!isRecord(requirement) || requirement.scheme !== 'exact' || typeof requirement.network !== 'string' || typeof requirement.asset !== 'string')
      continue;
    const extra = isRecord(requirement.extra) ? requirement.extra : {};
    if (extra['name'] === 'GatewayWalletBatched')
      continue;
    const network = findNetwork(requirement.network);
    if (!network || !(routableChains.x402 as readonly string[]).includes(network.chain))
      continue;
    const asset = config.assets.find(item => item.network.id === network.id && item.address.toLowerCase() === requirement.asset.toLowerCase());
    const atomicAmount = atomicOf(requirement);
    if (!asset || atomicAmount === undefined || atomicAmount <= 0n)
      continue;
    candidates.push({ protocol: 'x402', requirement, asset, atomicAmount, price: priceOf(atomicAmount, asset.decimals) });
  }
  for (const item of challenge.mpp) {
    const { charge } = checkMpp(item, config, now);
    if (!charge || !(routableChains.mpp as readonly string[]).includes(charge.asset.network.chain))
      continue;
    candidates.push({
      protocol: 'mpp', challenge: Challenge.serialize(item), expires: item.expires, bindsBody: item.digest !== undefined,
      asset: charge.asset, atomicAmount: charge.atomicAmount, price: charge.price,
    });
  }

  return candidates.sort((left, right) => left.price < right.price ? -1 : left.price > right.price ? 1 : protocolOrder[left.protocol] - protocolOrder[right.protocol])[0];
};

/**
 * What the target's answer says it settled of our payment (RT-9, RT-11): an x402 `PAYMENT-RESPONSE`
 * (or v1 `X-PAYMENT-RESPONSE`) with `success: true`, or a successful MPP `Payment-Receipt`, and its
 * transaction. Undefined when it says nothing was settled.
 */
export const targetReceipt = (headers: ResponseHeaders): { readonly receipt: string; readonly transaction: string | undefined } | undefined => {
  const first = (name: string): string | undefined => {
    const header = headers[name];
    const value = Array.isArray(header) ? header[0] : header;

    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const x402 = first('payment-response') ?? first('x-payment-response');
  if (x402 !== undefined) {
    try {
      const decoded = JSON.parse(Buffer.from(x402, 'base64').toString('utf8')) as { success?: unknown; transaction?: unknown };
      if (decoded.success === true)
        return { receipt: x402, transaction: typeof decoded.transaction === 'string' && decoded.transaction !== '' ? decoded.transaction : undefined };
    }
    catch {
      // Not a receipt
    }
  }
  const mpp = first('payment-receipt');
  if (mpp !== undefined) {
    try {
      const decoded = Receipt.deserialize(mpp);
      if (decoded.status === 'success')
        return { receipt: mpp, transaction: decoded.reference };
    }
    catch {
      // Not a receipt
    }
  }

  return undefined;
};

/** RT-5: the quote is the target's price plus the routing fee, rounded down (AR6). */
export const routingQuote = (price: MicroUsd, feeBps: number): { readonly quote: MicroUsd; readonly fee: MicroUsd } => {
  const fee = (price * BigInt(feeBps)) / 10_000n;

  return { quote: (price + fee) as MicroUsd, fee: fee as MicroUsd };
};
