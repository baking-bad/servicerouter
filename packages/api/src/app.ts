import type { FastifyInstance } from 'fastify';

import {
  createServer, randomIdGenerator, systemClock, type Clock, type IdGenerator, type Logger, type Server,
} from '@servicerouter/common';
import {
  cryptoRandomSource, type ApiKeyRepository, type PlatformConfig, type RandomSource,
} from '@servicerouter/core';
import { createApiKeyRepository, createRedisRateLimiter, type Postgres, type Redis } from '@servicerouter/db';

import { createMasterKeyAuth, decorateAccount } from './accounts/auth.js';
import { registerAccountRoutes } from './accounts/routes.js';
import { createAccountService } from './accounts/service.js';
import { createSignupLimit } from './accounts/signupLimit.js';
import { errorStatuses } from './errors.js';

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

  registerAccountRoutes(app, {
    accounts: createAccountService({ db: postgres.db, clock, ids, random, keyPrefixes: config.keyPrefixes }),
    authenticate: createMasterKeyAuth({ keyPrefixes: config.keyPrefixes, apiKeys }),
    signupLimit: createSignupLimit({ limiter: createRedisRateLimiter({ redis }), limit: config.rateLimits.signup }),
  });

  return server;
};
