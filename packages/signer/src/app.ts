import { Counter } from '@prometheus-io/client';
import type { PaymentRequirements } from '@x402/core/types';
import type { ClientSvmSigner } from '@x402/svm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Challenge } from 'mppx';
import type { LocalAccount } from 'viem';

import {
  createServer, formatUsd, isRecord, randomIdGenerator, Secret, ServiceRouterError, systemClock, type Clock, type IdGenerator, type Logger, type MicroUsd,
  type Server,
} from '@servicerouter/common';
import type { PlatformConfig } from '@servicerouter/core';
import { createRoutingRepository, type Postgres, type Redis } from '@servicerouter/db';

import { createSigner, SigningFailedError, SigningRefusedError, type SignRequest } from './sign.js';
import { createRedisSpendLimits, type SpendLimits } from './spend.js';
import { createTempoClient } from './tempo.js';

// The shared secret every sign request carries (SG-2)
export const signerSecretHeader = 'x-signer-secret';

export interface SignerDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly postgres: Postgres;
  readonly redis: Redis;
  // SIGNER_SECRET. Without it, every sign request is refused.
  readonly secret: Secret | undefined;
  // The hot wallets (SG-1)
  readonly wallets: { readonly base?: LocalAccount; readonly tempo?: LocalAccount; readonly solana?: ClientSvmSigner };
  // The Tempo RPC for MPP targets. Default: mpp.rpcUrl, else the chain's public RPC.
  readonly tempoRpcUrl?: string;
  // The Solana RPC for Solana targets: SOLANA_RPC_URL, which may carry a key. Default: the SDK's public RPC.
  readonly solanaRpcUrl?: Secret;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  // Request IDs for requests without one. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
  // Default: Redis counters with platform config's limits (SG-4, AR8)
  readonly spend?: SpendLimits;
}

const errorStatuses = { unauthorized: 401, invalid_request: 400, signing_refused: 422, signing_failed: 502 } as const;

class UnauthorizedError extends ServiceRouterError {
  readonly code = 'unauthorized';
}

class InvalidRequestError extends ServiceRouterError {
  readonly code = 'invalid_request';
}

// x402: `x402Version` and `requirement`. MPP: `challenge`. Without `protocol`, x402, as before MPP targets.
const signBodySchema = {
  type: 'object',
  required: ['quoteId', 'url', 'quotedPrice'],
  properties: {
    requestId: { type: 'string', maxLength: 128 },
    quoteId: { type: 'string', minLength: 1, maxLength: 128 },
    protocol: { type: 'string', enum: ['x402', 'mpp'] },
    x402Version: { type: 'integer', minimum: 1, maximum: 2 },
    requirement: { type: 'object' },
    resource: {},
    challenge: { type: 'string', minLength: 1, maxLength: 16_384 },
    url: { type: 'string', minLength: 1, maxLength: 4096 },
    quotedPrice: { type: 'string', pattern: '^\\d{1,20}$' },
  },
  additionalProperties: false,
} as const;

// A field as asked, for the log: a short string, or null
const short = (value: unknown): string | null => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 128) : null;

// What was asked, for a refusal's line (L-6): the option's or the challenge's network, asset, amount, and payTo
const askedFields = (body: SignBody): Record<string, string | null> => {
  if (body.protocol !== 'mpp') {
    const requirement = isRecord(body.requirement) ? body.requirement : {};

    return { network: short(requirement['network']), asset: short(requirement['asset']), atomicAmount: short(requirement['amount']), payTo: short(requirement['payTo']) };
  }
  try {
    const { request } = Challenge.deserialize(body.challenge ?? '');
    const details = isRecord(request['methodDetails']) ? request['methodDetails'] : {};

    return {
      network: details['chainId'] === undefined ? null : `eip155:${short(details['chainId'])}`, asset: short(request['currency']), atomicAmount: short(request['amount']),
      payTo: short(request['recipient']),
    };
  }
  catch {
    return { network: null, asset: null, atomicAmount: null, payTo: null };
  }
};

interface SignBody {
  readonly requestId?: string;
  readonly quoteId: string;
  readonly protocol?: 'x402' | 'mpp';
  readonly x402Version?: number;
  readonly requirement?: Record<string, unknown>;
  readonly resource?: unknown;
  readonly challenge?: string;
  readonly url: string;
  readonly quotedPrice: string;
}

const signRequestOf = (body: SignBody, quotedPrice: MicroUsd): SignRequest => {
  const { requestId, quoteId, url } = body;
  if (body.protocol === 'mpp') {
    if (body.challenge === undefined)
      throw new InvalidRequestError('An MPP payment needs the target\'s challenge');

    return { protocol: 'mpp', requestId, quoteId, url, quotedPrice, challenge: body.challenge };
  }
  if (body.x402Version === undefined || body.requirement === undefined)
    throw new InvalidRequestError('An x402 payment needs x402Version and the requirement');

  return {
    protocol: 'x402', requestId, quoteId, url, quotedPrice, x402Version: body.x402Version, requirement: body.requirement as unknown as PaymentRequirements, resource: body.resource,
  };
};

/**
 * The Signer (SG-1 to SG-9), on the internal network only: `POST /internal/v1/sign` with the shared
 * secret. Readiness covers Postgres and Redis: without its spend counters, it signs nothing.
 */
export const createApp = ({
  config, logger, postgres, redis, secret, wallets, tempoRpcUrl, solanaRpcUrl, clock = systemClock, ids = randomIdGenerator, requestIds,
  spend = createRedisSpendLimits({ redis, clock, hourly: config.signer.maxPerNetworkPerHour, daily: config.signer.maxPerNetworkPerDay }),
}: SignerDependencies): Server => {
  const server = createServer({
    logger,
    errorStatuses,
    ...(requestIds ? { requestIds } : {}),
    readinessChecks: [
      { name: 'postgres', check: () => postgres.ping() },
      { name: 'redis', check: () => redis.ping() },
    ],
  });
  const spent = new Counter({
    name: 'signer_spend_usd_total',
    help: 'USD the Signer signed for, per network (XC-2)',
    labelNames: ['network'] as const,
    registers: [server.metrics.registry],
  });
  const fees = new Counter({
    name: 'signer_fees_usd_total',
    help: 'The most our signed Tempo transactions pay in fees, in USD, per network: their gas limit at their maximum fee (T27)',
    labelNames: ['network'] as const,
    registers: [server.metrics.registry],
  });
  // MPP targets: the RPC the mppx client fills our Tempo transactions from, within the connect timeout
  const tempoClient = wallets.tempo
    ? createTempoClient({ network: config.mpp.network, url: tempoRpcUrl ?? config.mpp.rpcUrl, timeoutMs: config.timeouts.connectMs })
    : undefined;
  const signer = createSigner({
    config, wallets, ...tempoClient ? { tempoClient } : {}, ...solanaRpcUrl ? { solanaRpcUrl } : {}, spend, signatures: createRoutingRepository({ db: postgres.db, clock }), clock, ids,
    logger,
    onSigned: ({ network, amount, maxFee }) => {
      spent.inc({ network }, Number(amount) / 1_000_000);
      if (maxFee !== undefined)
        fees.inc({ network }, Number(maxFee) / 1_000_000);
    },
  });

  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers[signerSecretHeader];
    const given = typeof header === 'string' && header !== '' ? Secret.from(header) : undefined;
    try {
      if (secret && given?.equals(secret))
        return;
    }
    finally {
      given?.destroy();
    }
    reply.header('www-authenticate', 'Bearer');
    throw new UnauthorizedError(`The Signer needs the ${signerSecretHeader} header`);
  };

  server.app.post<{ Body: SignBody }>('/internal/v1/sign', { onRequest: authenticate, schema: { body: signBodySchema } }, async request => {
    const { body } = request;
    const { requestId, quoteId, url, quotedPrice } = body;
    if (!/^https:\/\//.test(url))
      throw new InvalidRequestError('url must be an HTTPS URL');
    const protocol = body.protocol ?? 'x402';
    // L-6: one line per sign request. The request's own ID labels it, as the proxy sent it (XC-5).
    const started = performance.now();
    const caller = requestId !== undefined && requestId !== request.id ? { callerRequestId: requestId } : {};
    let signed;
    try {
      signed = await signer.sign(signRequestOf(body, BigInt(quotedPrice) as MicroUsd), request.log);
    }
    catch (error) {
      const asked = { ...caller, quoteId, protocol, ...askedFields(body), quotedPrice: formatUsd(BigInt(quotedPrice)) };
      if (error instanceof SigningRefusedError) {
        request.log.info({
          ...asked, result: 'refused', reason: error.reason, message: error.message, ...error.spend, durationMs: Math.round(performance.now() - started),
        }, 'Refused to sign a routed payment');
      }
      // The RPC's short message only: never a request, a transaction, or the RPC's URL (L-9)
      else if (error instanceof SigningFailedError)
        request.log.warn({ ...asked, result: 'failed', reason: error.reason, durationMs: Math.round(performance.now() - started) }, 'Failed to sign a routed payment');
      throw error;
    }
    // Never the signed header: it pays the target (rule 10). For MPP, the most our transaction pays in fees.
    request.log.info({
      ...caller, quoteId, protocol: signed.protocol, network: signed.network, asset: signed.asset, amount: formatUsd(signed.amount),
      atomicAmount: signed.atomicAmount.toString(), payTo: signed.payTo, signatureId: signed.signatureId,
      ...signed.maxFee === undefined ? {} : { maxFee: formatUsd(signed.maxFee) }, result: 'signed', durationMs: Math.round(performance.now() - started),
    }, 'Signed a routed payment');

    return {
      header: signed.header,
      signatureId: signed.signatureId,
      network: signed.network,
      asset: signed.asset,
      atomicAmount: signed.atomicAmount.toString(),
      amount: signed.amount.toString(),
      payTo: signed.payTo,
    };
  });

  return server;
};
