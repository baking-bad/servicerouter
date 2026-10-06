import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';

import { isRecord, ServiceRouterError, type MicroUsd } from '@servicerouter/common';
import { findNetwork, type Asset, type PlatformConfig } from '@servicerouter/core';

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

/** What the target's 402 asks for (RT-3): x402 options, from the v2 header or the v1 body. */
export interface TargetChallenge {
  readonly x402Version: number;
  readonly accepts: readonly PaymentRequirements[];
  // The v2 resource, passed back when paying
  readonly resource: unknown;
}

/** Reads the x402 options of a target's 402: the `PAYMENT-REQUIRED` header (v2), or the JSON body (v1). */
export const parseTargetChallenge = (headers: Readonly<Record<string, string | readonly string[] | undefined>>, body: Uint8Array): TargetChallenge | undefined => {
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

/** The option the platform pays, with its asset and its price in micro-USD (RT-4). */
export interface ChosenOption {
  readonly protocol: 'x402';
  readonly requirement: PaymentRequirements;
  readonly asset: Asset;
  readonly atomicAmount: bigint;
  readonly price: MicroUsd;
}

// The chains the Signer holds wallets on (SG-1). Solana and Tempo join once the Signer signs for them.
export const routableChains = ['base'] as const;

const atomicOf = (requirement: PaymentRequirements): bigint | undefined => {
  const amount = (requirement as { amount?: unknown; maxAmountRequired?: unknown }).amount ?? (requirement as { maxAmountRequired?: unknown }).maxAmountRequired;

  return typeof amount === 'string' && /^\d{1,30}$/.test(amount) ? BigInt(amount) : undefined;
};

// Rounded up: the platform never quotes less than the target asks
const priceOf = (atomic: bigint, decimals: number): MicroUsd =>
  (decimals >= 6 ? (atomic + 10n ** BigInt(decimals - 6) - 1n) / 10n ** BigInt(decimals - 6) : atomic * 10n ** BigInt(6 - decimals)) as MicroUsd;

/**
 * Picks the cheapest option the platform pays (RT-4): `exact`, on a network the Signer pays on, in an
 * asset of the registry pegged to USD, and not a Circle Gateway nanopayment (AR16).
 */
export const chooseOption = (challenge: TargetChallenge, config: PlatformConfig): ChosenOption | undefined => {
  const candidates: ChosenOption[] = [];
  for (const requirement of challenge.accepts) {
    if (!isRecord(requirement) || requirement.scheme !== 'exact' || typeof requirement.network !== 'string' || typeof requirement.asset !== 'string')
      continue;
    const extra = isRecord(requirement.extra) ? requirement.extra : {};
    if (extra['name'] === 'GatewayWalletBatched')
      continue;
    const network = findNetwork(requirement.network);
    if (!network || !(routableChains as readonly string[]).includes(network.chain))
      continue;
    const asset = config.assets.find(item => item.network.id === network.id && item.address.toLowerCase() === requirement.asset.toLowerCase());
    const atomicAmount = atomicOf(requirement);
    if (!asset || atomicAmount === undefined || atomicAmount <= 0n)
      continue;
    candidates.push({ protocol: 'x402', requirement, asset, atomicAmount, price: priceOf(atomicAmount, asset.decimals) });
  }

  return candidates.sort((left, right) => (left.price < right.price ? -1 : left.price > right.price ? 1 : 0))[0];
};

/** RT-5: the quote is the target's price plus the routing fee, rounded down (AR6). */
export const routingQuote = (price: MicroUsd, feeBps: number): { readonly quote: MicroUsd; readonly fee: MicroUsd } => {
  const fee = (price * BigInt(feeBps)) / 10_000n;

  return { quote: (price + fee) as MicroUsd, fee: fee as MicroUsd };
};
