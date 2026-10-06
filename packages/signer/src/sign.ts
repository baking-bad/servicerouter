import { x402Client } from '@x402/core/client';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import type { LocalAccount } from 'viem';

import { formatUsd, isRecord, ServiceRouterError, type Clock, type IdGenerator, type Logger, type LogSink, type MicroUsd } from '@servicerouter/common';
import { findNetwork, type PlatformConfig } from '@servicerouter/core';
import type { RoutingRepository } from '@servicerouter/db';

import type { SpendLimits, SpendRefusal } from './spend.js';

/** Why the Signer refused, as a code for the log (L-6). The message says it in words. */
export type SigningRefusal = 'not_exact' | 'not_in_registry' | 'no_wallet' | 'invalid_amount' | 'above_quote' | 'above_max_per_call' | SpendRefusal;

/** A spend window's total against its limit, in USD, when a limit refused (L-6). */
export interface SpendWindow {
  readonly window: 'hour' | 'day';
  readonly spent: string;
  readonly limit: string;
}

/** The Signer won't sign this (SG-3, SG-4). The proxy answers 503 upstream_unavailable, and the buyer pays nothing. */
export class SigningRefusedError extends ServiceRouterError {
  readonly code = 'signing_refused';
  readonly reason: SigningRefusal;
  readonly spend: SpendWindow | undefined;

  constructor(message: string, reason: SigningRefusal, spend?: SpendWindow) {
    super(message);

    this.reason = reason;
    this.spend = spend;
  }
}

/** `POST /internal/v1/sign` (SG-2): what to sign, for which quote. */
export interface SignRequest {
  readonly requestId: string | undefined;
  readonly quoteId: string;
  readonly x402Version: number;
  // The chosen option of the target's 402
  readonly requirement: PaymentRequirements;
  // The target's v2 resource, passed back as it came
  readonly resource: unknown;
  // The resource URL, for the record
  readonly url: string;
  // The target price the buyer was quoted, in micro-USD: never sign above it (SG-3)
  readonly quotedPrice: MicroUsd;
}

export interface SignResult {
  // The PAYMENT-SIGNATURE value
  readonly header: string;
  readonly signatureId: string;
  readonly network: string;
  readonly asset: string;
  readonly atomicAmount: bigint;
  readonly amount: MicroUsd;
  readonly payTo: string;
}

export interface Signer {
  /** Signs, or throws SigningRefusedError. `log`: the request's logger, for the spend limit's alert. */
  sign(request: SignRequest, log?: LogSink): Promise<SignResult>;
}

export interface SignerOptions {
  readonly config: PlatformConfig;
  // One hot wallet per chain (SG-1): Base in step 12
  readonly wallets: { readonly base?: LocalAccount };
  readonly spend: SpendLimits;
  readonly signatures: Pick<RoutingRepository, 'recordSignature'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  // Spend per network, for the metrics (XC-2)
  readonly onSigned?: (network: string, amount: MicroUsd) => void;
}

const refuse = (message: string, reason: SigningRefusal, spend?: SpendWindow): never => {
  throw new SigningRefusedError(message, reason, spend);
};

/**
 * Signs payments to routed targets (SG-2 to SG-8): checks the network and asset against the registry,
 * the amount against the quote and the per-call maximum, and the spend limits, in that order. Then it
 * signs with the official x402 client and records the signature. It never hand-rolls an authorization.
 */
export const createSigner = ({ config, wallets, spend, signatures, clock, ids, logger, onSigned }: SignerOptions): Signer => ({
  sign: async (request, log = logger) => {
    const { requirement } = request;
    if (!isRecord(requirement) || requirement.scheme !== 'exact' || typeof requirement.network !== 'string' || typeof requirement.asset !== 'string')
      return refuse('Only exact x402 options can be signed', 'not_exact');
    const network = findNetwork(requirement.network);
    const asset = network && config.assets.find(item => item.network.id === network.id && item.address.toLowerCase() === requirement.asset.toLowerCase());
    if (!network || !asset)
      return refuse('The network and asset aren\'t in the registry', 'not_in_registry');
    const account = network.chain === 'base' ? wallets.base : undefined;
    if (!account)
      return refuse(`The Signer holds no wallet on ${network.title}`, 'no_wallet');
    const amountText = (requirement as { amount?: unknown }).amount;
    if (typeof amountText !== 'string' || !/^\d{1,30}$/.test(amountText) || BigInt(amountText) <= 0n)
      return refuse('The option has no valid amount', 'invalid_amount');
    const atomicAmount = BigInt(amountText);
    const scale = 10n ** BigInt(Math.abs(asset.decimals - 6));
    // Rounded up, so a fraction of a micro-USD never slips under a limit
    const amount = (asset.decimals >= 6 ? (atomicAmount + scale - 1n) / scale : atomicAmount * scale) as MicroUsd;
    if (amount > request.quotedPrice)
      return refuse('The amount is above the quoted price', 'above_quote');
    if (amount > config.signer.maxPerCall)
      return refuse('The amount is above the per-call maximum', 'above_max_per_call');
    const { refusal, hour, day } = await spend.reserve({ network: network.id, amount });
    if (refusal) {
      // L-6: the window's total against its limit
      const hourly = refusal === 'hourly_limit';
      const window: SpendWindow = {
        window: hourly ? 'hour' : 'day',
        spent: formatUsd(hourly ? hour : day),
        limit: formatUsd(hourly ? config.signer.maxPerNetworkPerHour ?? 0n : config.signer.maxPerNetworkPerDay),
      };
      log.error({ network: network.id, refusal, amount: formatUsd(amount), ...window, alert: true }, 'The Signer refused a payment: a spend limit is reached');

      return refuse(hourly ? 'The hourly spend limit is reached' : 'The daily spend limit is reached', refusal, window);
    }

    const client = new x402Client().register(network.id as `${string}:${string}`, new ExactEvmScheme(account));
    const payload = await client.createPaymentPayload({
      x402Version: request.x402Version,
      accepts: [requirement],
      ...request.resource === undefined ? {} : { resource: request.resource },
    } as Parameters<typeof client.createPaymentPayload>[0]);
    const signatureId = `sig_${ids.next()}`;
    await signatures.recordSignature({
      id: signatureId, requestId: request.requestId ?? null, quoteId: request.quoteId, protocol: 'x402', network: network.id, asset: asset.name,
      atomicAmount, amount, payTo: String(requirement.payTo), resource: request.url, createdAt: clock.now(),
    });
    onSigned?.(network.id, amount);

    return { header: encodePaymentSignatureHeader(payload), signatureId, network: network.id, asset: asset.name, atomicAmount, amount, payTo: String(requirement.payTo) };
  },
});
