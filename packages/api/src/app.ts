import type { FastifyInstance } from 'fastify';

import {
  createServer, OutboundHttp, randomIdGenerator, systemClock, type Clock, type IdGenerator, type Logger, type Server,
} from '@servicerouter/common';
import {
  assumeHostsVerified, cryptoRandomSource, openApiFetchLimits, type ApiKeyRepository, type InvalidationBus, type OwnershipStatus,
  type PlatformConfig, type RandomSource, type SecretSealer,
} from '@servicerouter/core';
import {
  createApiKeyRepository, createRedisInvalidationBus, createRedisRateLimiter, type Postgres, type Redis,
} from '@servicerouter/db';

import { createMasterKeyAuth, decorateAccount } from './accounts/auth.js';
import { registerAccountRoutes } from './accounts/routes.js';
import { createAccountService } from './accounts/service.js';
import { createSignupLimit } from './accounts/signupLimit.js';
import { errorStatuses } from './errors.js';
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
  // Whether a service's hosts are verified (SR-8). Default: the step 2 adapter, every host verified (S2-D1).
  readonly ownership?: OwnershipStatus;
  // Where activations and secret writes are announced (SR-7, SC-7). Default: the Redis channel.
  readonly invalidation?: Pick<InvalidationBus, 'publish'>;
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
  ownership = assumeHostsVerified,
  invalidation = createRedisInvalidationBus({ redis, logger }),
}: ApiDependencies): Server => {
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
  registerAccountRoutes(app, {
    accounts: createAccountService({ db: postgres.db, clock, ids, random, keyPrefixes: config.keyPrefixes }),
    authenticate,
    signupLimit: createSignupLimit({ limiter: createRedisRateLimiter({ redis }), limit: config.rateLimits.signup }),
  });

  let http = openApiHttp;
  if (!http) {
    const outbound = new OutboundHttp({ ownHosts: config.ownHosts, connectTimeoutMs: openApiFetchLimits.connectTimeoutMs });
    app.addHook('onClose', async () => outbound.close());
    http = outbound;
  }
  registerServiceRoutes(app, {
    registry: createServiceRegistry({ db: postgres.db, platform: config, clock, ids, logger, sealer, http, ownership, invalidation }),
    authenticate,
  });

  return server;
};
