import { x402Client } from '@x402/core/client';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import type { ClientSvmSigner } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { Challenge } from 'mppx';
import type { Client, LocalAccount } from 'viem';

import { formatUsd, isRecord, ServiceRouterError, type Clock, type IdGenerator, type Logger, type LogSink, type MicroUsd, type Secret } from '@servicerouter/common';
import { checkTempoCharge, findNetwork, type Asset, type PlatformConfig, type TempoChargeRefusal } from '@servicerouter/core';
import type { RoutingRepository } from '@servicerouter/db';

import type { SpendLimits, SpendRefusal } from './spend.js';
import { errorReason, maxFeeOf, signTempoCharge } from './tempo.js';

/** Why the Signer refused, as a code for the log (L-6). The message says it in words. */
export type SigningRefusal = 'not_exact' | 'not_in_registry' | 'no_wallet' | 'invalid_amount' | 'above_quote' | 'above_max_per_call' | 'expired'
  | 'no_fee_payer' | 'fee_payer_is_us' | TempoChargeRefusal | SpendRefusal;

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

/** The chain's RPC failed while the Signer built a transaction (Tempo, Solana): nothing was signed. The buyer pays nothing. */
export class SigningFailedError extends ServiceRouterError {
  readonly code = 'signing_failed';
  readonly reason: string;

  constructor(chain: string, reason: string, options?: ErrorOptions) {
    super(`The Signer couldn't build the ${chain} payment: the ${chain} RPC failed`, options);

    this.reason = reason;
  }
}

/** `POST /internal/v1/sign` (SG-2): what to sign, for which quote. */
export type SignRequest = {
  readonly requestId: string | undefined;
  readonly quoteId: string;
  // The resource URL, for the record
  readonly url: string;
  // The target price the buyer was quoted, in micro-USD: never sign above it (SG-3)
  readonly quotedPrice: MicroUsd;
} & ({
  readonly protocol: 'x402';
  readonly x402Version: number;
  // The chosen option of the target's 402
  readonly requirement: PaymentRequirements;
  // The target's v2 resource, passed back as it came
  readonly resource: unknown;
} | {
  readonly protocol: 'mpp';
  // The target's `WWW-Authenticate: Payment` challenge, as it sent it
  readonly challenge: string;
});

export interface SignResult {
  readonly protocol: 'x402' | 'mpp';
  // The PAYMENT-SIGNATURE value, or the MPP Authorization value
  readonly header: string;
  readonly signatureId: string;
  readonly network: string;
  readonly asset: string;
  readonly atomicAmount: bigint;
  readonly amount: MicroUsd;
  readonly payTo: string;
  // MPP: the most our transaction pays in fees, in micro-USD. 0 when the target sponsors it.
  readonly maxFee: MicroUsd | undefined;
}

export interface Signer {
  /** Signs, or throws SigningRefusedError. `log`: the request's logger, for the spend limit's alert. */
  sign(request: SignRequest, log?: LogSink): Promise<SignResult>;
}

export interface SignerOptions {
  readonly config: PlatformConfig;
  // One hot wallet per chain (SG-1): Base and Solana for x402 targets, and Tempo for MPP targets
  readonly wallets: { readonly base?: LocalAccount; readonly tempo?: LocalAccount; readonly solana?: ClientSvmSigner };
  // The Tempo RPC of mpp.network, for MPP targets
  readonly tempoClient?: Client;
  // The Solana RPC the x402 client builds payments with: SOLANA_RPC_URL, which may carry a key in its path.
  // Undefined: the SDK's public RPC for the network.
  readonly solanaRpcUrl?: Secret;
  readonly spend: SpendLimits;
  readonly signatures: Pick<RoutingRepository, 'recordSignature'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  // Spend and fees per network, for the metrics (XC-2)
  readonly onSigned?: (signed: SignResult) => void;
}

const refuse = (message: string, reason: SigningRefusal, spend?: SpendWindow): never => {
  throw new SigningRefusedError(message, reason, spend);
};

const mppRefusalMessages: Readonly<Record<TempoChargeRefusal, string>> = {
  not_tempo_charge: 'The challenge isn\'t a Tempo charge',
  wrong_chain: 'The challenge is for another chain than mpp.network',
  push_only: 'The challenge accepts only push mode: the Signer pays in pull mode',
  splits: 'The challenge splits the payment, which the Signer doesn\'t pay',
  unsupported_currency: 'The challenge\'s currency isn\'t an asset of the registry on mpp.network',
  invalid_amount: 'The challenge has no valid amount',
};

/**
 * Signs payments to routed targets (SG-2 to SG-8): checks the network and asset against the registry,
 * the amount against the quote and the per-call maximum, and the spend limits per network, in that
 * order. Then it signs with the official client, x402's or `mppx`'s, and records the signature. It never
 * hand-rolls an authorization or a transaction.
 */
export const createSigner = ({ config, wallets, tempoClient, solanaRpcUrl, spend, signatures, clock, ids, logger, onSigned }: SignerOptions): Signer => {
  // One per Signer, so the SDK's cache of mint accounts lasts across payments
  const solanaScheme = wallets.solana && new ExactSvmScheme(wallets.solana, solanaRpcUrl ? { rpcUrl: solanaRpcUrl.expose() } : undefined);
  // An RPC error's reason without a URL, or SOLANA_RPC_URL's path, which may be its key (L-9)
  const solanaRpcPath = solanaRpcUrl && new URL(solanaRpcUrl.expose()).pathname;
  const solanaReason = (error: unknown): string => {
    const reason = errorReason(error).replace(/https?:\/\/\S+/g, '<rpc>');

    return solanaRpcPath && solanaRpcPath.length > 1 ? reason.split(solanaRpcPath).join('<rpc>') : reason;
  };

  // SG-3, SG-4: the amount against the quote and the per-call maximum, then the spend limits
  const checkAmount = async (network: string, amount: MicroUsd, quotedPrice: MicroUsd, log: LogSink): Promise<void> => {
    if (amount > quotedPrice)
      return refuse('The amount is above the quoted price', 'above_quote');
    if (amount > config.signer.maxPerCall)
      return refuse('The amount is above the per-call maximum', 'above_max_per_call');
    const { refusal, hour, day } = await spend.reserve({ network, amount });
    if (refusal) {
      // L-6: the window's total against its limit
      const hourly = refusal === 'hourly_limit';
      const window: SpendWindow = {
        window: hourly ? 'hour' : 'day',
        spent: formatUsd(hourly ? hour : day),
        limit: formatUsd(hourly ? config.signer.maxPerNetworkPerHour ?? 0n : config.signer.maxPerNetworkPerDay),
      };
      log.error({ network, refusal, amount: formatUsd(amount), ...window, alert: true }, 'The Signer refused a payment: a spend limit is reached');

      return refuse(hourly ? 'The hourly spend limit is reached' : 'The daily spend limit is reached', refusal, window);
    }
  };

  const record = async (request: SignRequest, signed: Omit<SignResult, 'signatureId'>): Promise<SignResult> => {
    const signatureId = `sig_${ids.next()}`;
    await signatures.recordSignature({
      id: signatureId, requestId: request.requestId ?? null, quoteId: request.quoteId, protocol: signed.protocol, network: signed.network, asset: signed.asset,
      atomicAmount: signed.atomicAmount, amount: signed.amount, payTo: signed.payTo, resource: request.url, createdAt: clock.now(),
    });
    const result = { ...signed, signatureId };
    onSigned?.(result);

    return result;
  };

  const amountOf = (atomicAmount: bigint, asset: Asset): MicroUsd => {
    const scale = 10n ** BigInt(Math.abs(asset.decimals - 6));

    // Rounded up, so a fraction of a micro-USD never slips under a limit
    return (asset.decimals >= 6 ? (atomicAmount + scale - 1n) / scale : atomicAmount * scale) as MicroUsd;
  };

  const signX402 = async (request: Extract<SignRequest, { protocol: 'x402' }>, log: LogSink): Promise<SignResult> => {
    const { requirement } = request;
    if (!isRecord(requirement) || requirement.scheme !== 'exact' || typeof requirement.network !== 'string' || typeof requirement.asset !== 'string')
      return refuse('Only exact x402 options can be signed', 'not_exact');
    const network = findNetwork(requirement.network);
    const asset = network && config.assets.find(item => item.network.id === network.id && item.address.toLowerCase() === requirement.asset.toLowerCase());
    if (!network || !asset)
      return refuse('The network and asset aren\'t in the registry', 'not_in_registry');
    const scheme = network.chain === 'base' ? wallets.base && new ExactEvmScheme(wallets.base) : network.chain === 'solana' ? solanaScheme : undefined;
    if (!scheme)
      return refuse(`The Signer holds no wallet on ${network.title}`, 'no_wallet');
    // Solana: the target's facilitator pays the transaction's fee, never our wallet. Checked before the spend limits count it.
    if (network.chain === 'solana') {
      const feePayer = isRecord(requirement.extra) ? requirement.extra['feePayer'] : undefined;
      if (typeof feePayer !== 'string' || feePayer === '')
        return refuse('The Solana option names no fee payer: the Signer never pays a transaction\'s fee', 'no_fee_payer');
      if (feePayer === wallets.solana?.address)
        return refuse('The Solana option names our wallet as its fee payer', 'fee_payer_is_us');
    }
    const amountText = (requirement as { amount?: unknown }).amount;
    if (typeof amountText !== 'string' || !/^\d{1,30}$/.test(amountText) || BigInt(amountText) <= 0n)
      return refuse('The option has no valid amount', 'invalid_amount');
    const atomicAmount = BigInt(amountText);
    const amount = amountOf(atomicAmount, asset);
    await checkAmount(network.id, amount, request.quotedPrice, log);

    const client = new x402Client().register(network.id as `${string}:${string}`, scheme);
    let payload;
    try {
      payload = await client.createPaymentPayload({
        x402Version: request.x402Version,
        accepts: [requirement],
        ...request.resource === undefined ? {} : { resource: request.resource },
      } as Parameters<typeof client.createPaymentPayload>[0]);
    }
    catch (error) {
      // Solana's client reads the mint and a blockhash from the RPC. Its error stays out: it may name the RPC.
      if (network.chain === 'solana')
        throw new SigningFailedError(network.title, solanaReason(error));
      throw error;
    }

    return record(request, {
      protocol: 'x402', header: encodePaymentSignatureHeader(payload), network: network.id, asset: asset.name, atomicAmount, amount,
      payTo: String(requirement.payTo), maxFee: undefined,
    });
  };

  const signMpp = async (request: Extract<SignRequest, { protocol: 'mpp' }>, log: LogSink): Promise<SignResult> => {
    let challenge: Challenge.Challenge;
    try {
      challenge = Challenge.deserialize(request.challenge);
    }
    catch {
      return refuse(mppRefusalMessages.not_tempo_charge, 'not_tempo_charge');
    }
    const { charge, refusal } = checkTempoCharge(challenge, config);
    if (refusal !== undefined)
      return refuse(mppRefusalMessages[refusal], refusal);
    const network = config.mpp.network;
    const account = wallets.tempo;
    if (!account || !tempoClient)
      return refuse(`The Signer holds no wallet on ${network.title}`, 'no_wallet');
    if (challenge.expires !== undefined && Date.parse(challenge.expires) <= clock.now().getTime())
      return refuse('The challenge has expired', 'expired');
    await checkAmount(network.id, charge.price, request.quotedPrice, log);

    let header: string;
    try {
      header = await signTempoCharge({ account, client: tempoClient, challenge });
    }
    catch (error) {
      throw new SigningFailedError('Tempo', errorReason(error), { cause: error });
    }

    return record(request, {
      protocol: 'mpp', header, network: network.id, asset: charge.asset.name, atomicAmount: charge.atomicAmount, amount: charge.price, payTo: charge.recipient,
      maxFee: charge.sponsored ? 0n as MicroUsd : maxFeeOf(header),
    });
  };

  return {
    sign: async (request, log = logger) => request.protocol === 'mpp' ? signMpp(request, log) : signX402(request, log),
  };
};
