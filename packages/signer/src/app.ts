import { Counter } from '@prometheus-io/client';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  createServer, formatUsd, isRecord, randomIdGenerator, Secret, ServiceRouterError, systemClock, type Clock, type IdGenerator, type Logger, type MicroUsd,
  type Server,
} from '@servicerouter/common';
import type { PlatformConfig } from '@servicerouter/core';
import { createRoutingRepository, type Postgres, type Redis } from '@servicerouter/db';
import type { LocalAccount } from 'viem';

import { createSigner, SigningRefusedError, type SignRequest } from './sign.js';
import { createRedisSpendLimits, type SpendLimits } from './spend.js';

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
  readonly wallets: { readonly base?: LocalAccount };
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  // Request IDs for requests without one. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
  // Default: Redis counters with platform config's limits (SG-4, AR8)
  readonly spend?: SpendLimits;
}

const errorStatuses = { unauthorized: 401, invalid_request: 400, signing_refused: 422 } as const;

class UnauthorizedError extends ServiceRouterError {
  readonly code = 'unauthorized';
}

class InvalidRequestError extends ServiceRouterError {
  readonly code = 'invalid_request';
}

const signBodySchema = {
  type: 'object',
  required: ['quoteId', 'x402Version', 'requirement', 'url', 'quotedPrice'],
  properties: {
    requestId: { type: 'string', maxLength: 128 },
    quoteId: { type: 'string', minLength: 1, maxLength: 128 },
    x402Version: { type: 'integer', minimum: 1, maximum: 2 },
    requirement: { type: 'object' },
    resource: {},
    url: { type: 'string', minLength: 1, maxLength: 4096 },
    quotedPrice: { type: 'string', pattern: '^\\d{1,20}$' },
  },
  additionalProperties: false,
} as const;

// A field of the option as asked, for the log: a short string, or null
const askedField = (requirement: unknown, name: string): string | null => {
  const value = isRecord(requirement) ? requirement[name] : undefined;

  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 128) : null;
};

interface SignBody {
  readonly requestId?: string;
  readonly quoteId: string;
  readonly x402Version: number;
  readonly requirement: SignRequest['requirement'];
  readonly resource?: unknown;
  readonly url: string;
  readonly quotedPrice: string;
}

/**
 * The Signer (SG-1 to SG-9), on the internal network only: `POST /internal/v1/sign` with the shared
 * secret. Readiness covers Postgres and Redis: without its spend counters, it signs nothing.
 */
export const createApp = ({
  config, logger, postgres, redis, secret, wallets, clock = systemClock, ids = randomIdGenerator, requestIds,
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
  const signer = createSigner({
    config, wallets, spend, signatures: createRoutingRepository({ db: postgres.db, clock }), clock, ids, logger,
    onSigned: (network, amount: MicroUsd) => spent.inc({ network }, Number(amount) / 1_000_000),
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
    const { requestId, quoteId, x402Version, requirement, resource, url, quotedPrice } = request.body;
    if (!/^https:\/\//.test(url))
      throw new InvalidRequestError('url must be an HTTPS URL');
    // L-6: one line per sign request. The request's own ID labels it, as the proxy sent it (XC-5).
    const started = performance.now();
    const caller = requestId !== undefined && requestId !== request.id ? { callerRequestId: requestId } : {};
    let signed;
    try {
      signed = await signer.sign({
        requestId, quoteId, x402Version, requirement, resource, url, quotedPrice: BigInt(quotedPrice) as MicroUsd,
      }, request.log);
    }
    catch (error) {
      if (error instanceof SigningRefusedError) {
        request.log.info({
          ...caller, quoteId, network: askedField(requirement, 'network'), asset: askedField(requirement, 'asset'), atomicAmount: askedField(requirement, 'amount'),
          payTo: askedField(requirement, 'payTo'), quotedPrice: formatUsd(BigInt(quotedPrice)), result: 'refused', reason: error.reason, message: error.message,
          ...error.spend, durationMs: Math.round(performance.now() - started),
        }, 'Refused to sign a routed payment');
      }
      throw error;
    }
    // Never the signed header: it pays the target (rule 10)
    request.log.info({
      ...caller, quoteId, network: signed.network, asset: signed.asset, amount: formatUsd(signed.amount), atomicAmount: signed.atomicAmount.toString(),
      payTo: signed.payTo, signatureId: signed.signatureId, result: 'signed', durationMs: Math.round(performance.now() - started),
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
