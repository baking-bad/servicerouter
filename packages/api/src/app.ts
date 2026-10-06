import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';

import {
  createServer, OutboundHttp, randomIdGenerator, systemClock, type Clock, type IdGenerator, type ListenOptions, type Logger, type Secret,
  type Server, type ServerAddresses,
} from '@servicerouter/common';
import {
  createOwnershipFileFetcher, createOwnershipVerifier, cryptoRandomSource, openApiFetchLimits, ownershipFileLimits, type ApiKeyRepository,
  type DepositAddressDeriver, type InvalidationBus, type OwnershipStatus, type PlatformConfig, type RandomSource, type SecretSealer,
} from '@servicerouter/core';
import {
  createApiKeyRepository, createOwnershipStatus, createOwnershipStore, createRedisInvalidationBus, createRedisRateLimiter, type Postgres,
  type Redis,
} from '@servicerouter/db';

import { createMasterKeyAuth, decorateAccount } from './accounts/auth.js';
import { registerAccountRoutes } from './accounts/routes.js';
import { createAccountService } from './accounts/service.js';
import { createIpLimit, createSignupLimit } from './accounts/signupLimit.js';
import { registerAgentDocRoutes } from './agentDocs/routes.js';
import { createAgentDocsService } from './agentDocs/service.js';
import { registerDepositRoutes } from './deposits/routes.js';
import { createDepositService } from './deposits/service.js';
import { errorStatuses } from './errors.js';
import { registerInternalRoutes } from './internal/routes.js';
import { registerKeyRoutes } from './keys/routes.js';
import { createPaymentKeyService } from './keys/service.js';
import { registerLedgerRoutes } from './ledger/routes.js';
import { registerServiceRoutes } from './services/routes.js';
import { createServiceRegistry } from './services/service.js';

export interface ApiDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly postgres: Postgres;
  readonly redis: Redis;
  // Times of accounts, keys, and audit entries. Default: the system clock.
  readonly clock?: Clock;
  // IDs of accounts, keys, and audit entries. Default: random UUIDs.
  readonly ids?: IdGenerator;
  // Randomness for keys. Default: node:crypto.
  readonly random?: RandomSource;
  // Request IDs for requests without one. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
  // The proxies in front, whose X-Forwarded-For gives the client IP. Default: none.
  readonly trustProxy?: string;
  // Master key lookups. Default: the api_keys repository.
  readonly apiKeys?: Pick<ApiKeyRepository, 'findActiveByHash'>;
  // Seals seller secrets with the proxy's public key (SC-2). See `readSecretsSealer`.
  readonly sealer: SecretSealer;
  // Fetches sellers' OpenAPI documents (SR-3). Default: Outbound HTTP with the production address
  // policy, the platform's own hosts refused (OH-5), and the S2-D2 connect timeout. Closed with the app.
  readonly openApiHttp?: Pick<OutboundHttp, 'request'>;
  // The hosts' states at activation (SR-8). Default: the upstream_hosts table. Tests that aren't about
  // ownership pass `assumeHostsVerified`.
  readonly ownership?: OwnershipStatus;
  // Fetches the hosts' ownership files (OV-2). Default: Outbound HTTP with the production address policy,
  // the platform's own hosts refused, and a 5 s connect timeout. Closed with the app.
  readonly ownershipHttp?: Pick<OutboundHttp, 'request'>;
  // The ownership file's URL for a host. Default: https://<host>/.well-known/servicerouter.json. Tests
  // point it at a fake upstream's port.
  readonly ownershipFileUrl?: (host: string) => string;
  // Where activations, secret writes, and key changes are announced (SR-7, SC-7, AK-9). Default: the Redis channel.
  readonly invalidation?: Pick<InvalidationBus, 'publish'>;
  // INTERNAL_API_SECRET, the shared secret of the internal API (PA-4). Without it, every internal call is refused.
  readonly internalSecret?: Secret;
  // Derives deposit addresses from DEPOSIT_ACCOUNT_PUBLIC_KEY (DP-1). Without it, signup creates no deposit address.
  readonly depositAddresses?: DepositAddressDeriver;
}

export interface ApiListenOptions extends ListenOptions {
  // The internal listener's port (PA-4). Without it, the internal API doesn't listen.
  readonly internalPort?: number;
}

export interface ApiAddresses extends ServerAddresses {
  readonly internalPort: number | undefined;
}

/** The public listener and the metrics listener, plus the internal listener, which Traefik never routes to (PA-4). */
export interface ApiServer extends Server {
  readonly internal: FastifyInstance;
  listen(options: ApiListenOptions): Promise<ApiAddresses>;
}

// A POST with `Content-Type: application/json` and no body has no body, rather than invalid JSON
const acceptEmptyJson = (app: FastifyInstance): void => {
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text === '')
      done(null, undefined);
    else
      parseJson(request, text, done);
  });
};

/** The Platform API on api.servicerouter.ai. Readiness covers Postgres and Redis (PA-6). */
export const createApp = ({
  config,
  logger,
  postgres,
  redis,
  clock = systemClock,
  ids = randomIdGenerator,
  random = cryptoRandomSource,
  requestIds,
  trustProxy,
  apiKeys = createApiKeyRepository({ db: postgres.db }),
  sealer,
  openApiHttp,
  ownership = createOwnershipStatus({ db: postgres.db }),
  ownershipHttp,
  ownershipFileUrl,
  invalidation = createRedisInvalidationBus({ redis, logger }),
  internalSecret,
  depositAddresses,
}: ApiDependencies): ApiServer => {
  const server = createServer({
    logger,
    errorStatuses,
    requestIds,
    trustProxy,
    readinessChecks: [
      { name: 'postgres', check: () => postgres.ping() },
      { name: 'redis', check: () => redis.ping() },
    ],
  });
  const { app } = server;
  decorateAccount(app);
  acceptEmptyJson(app);

  const authenticate = createMasterKeyAuth({ keyPrefixes: config.keyPrefixes, apiKeys });
  const limiter = createRedisRateLimiter({ redis });
  const deposits = createDepositService({ db: postgres.db, config, clock, ids, logger, deriver: depositAddresses, random });
  registerAccountRoutes(app, {
    accounts: createAccountService({ db: postgres.db, clock, ids, random, keyPrefixes: config.keyPrefixes }),
    authenticate,
    signupLimit: createSignupLimit({ limiter, limit: config.rateLimits.signup }),
    deposits,
  });
  registerDepositRoutes(app, { deposits, topupLimit: createIpLimit({ limiter, limit: config.rateLimits.topup, name: 'topup' }) });
  registerAgentDocRoutes(app, {
    docs: createAgentDocsService({ db: postgres.db, config, clock }),
    limit: createIpLimit({ limiter, limit: config.rateLimits.documents, name: 'docs' }),
  });

  let http = openApiHttp;
  if (!http) {
    const outbound = new OutboundHttp({ ownHosts: config.ownHosts, connectTimeoutMs: openApiFetchLimits.connectTimeoutMs });
    app.addHook('onClose', async () => outbound.close());
    http = outbound;
  }
  let fileHttp = ownershipHttp;
  if (!fileHttp) {
    const outbound = new OutboundHttp({ ownHosts: config.ownHosts, connectTimeoutMs: ownershipFileLimits.connectTimeoutMs });
    app.addHook('onClose', async () => outbound.close());
    fileHttp = outbound;
  }
  const verifier = createOwnershipVerifier({
    store: createOwnershipStore({ db: postgres.db, clock, ids, random }),
    fetchFile: createOwnershipFileFetcher({ http: fileHttp, ...(ownershipFileUrl ? { fileUrl: ownershipFileUrl } : {}) }),
    clock,
    invalidation,
    logger,
  });
  registerServiceRoutes(app, {
    registry: createServiceRegistry({
      db: postgres.db, platform: config, clock, ids, logger, sealer, http, ownership, verifier, random, invalidation,
    }),
    authenticate,
  });
  registerKeyRoutes(app, {
    keys: createPaymentKeyService({
      db: postgres.db,
      clock,
      ids,
      random,
      keyPrefixes: config.keyPrefixes,
      defaultDailyBudget: config.paymentKeyDefaults.dailyBudget,
      invalidation,
      logger,
    }),
    authenticate,
    clock,
  });
  registerLedgerRoutes(app, { db: postgres.db, clock, ids, authenticate });

  // The internal API on a listener of its own, with the same request IDs, logs, and error envelope
  const internal = createServer({ logger, errorStatuses, requestIds });
  registerInternalRoutes(internal.app, { db: postgres.db, clock, ids, secret: internalSecret, verifier, environment: config.environment });

  return {
    ...server,
    internal: internal.app,
    listen: async options => {
      const addresses = await server.listen(options);
      if (options.internalPort === undefined)
        return { ...addresses, internalPort: undefined };

      try {
        await internal.app.listen({ host: options.host, port: options.internalPort });
      }
      catch (error) {
        await server.close();
        throw error;
      }

      return { ...addresses, internalPort: (internal.app.server.address() as AddressInfo).port };
    },
    close: async () => {
      await internal.app.close();
      await server.close();
    },
  };
};
