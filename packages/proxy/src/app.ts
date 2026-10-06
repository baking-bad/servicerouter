import { createServer, type IdGenerator, type Logger, type Server } from '@servicerouter/common';
import type { PlatformConfig } from '@servicerouter/core';
import type { Postgres, Redis } from '@servicerouter/db';

import { errorStatuses } from './errors.js';

export interface ProxyDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly postgres: Postgres;
  readonly redis: Redis;
  // Request IDs for requests without one. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
}

/**
 * The proxy on pay.servicerouter.ai. Readiness covers Postgres and Redis. Facilitators join it with
 * x402 (PX-17).
 */
export const createApp = ({ config, logger, postgres, redis, requestIds }: ProxyDependencies): Server => createServer({
  logger,
  errorStatuses,
  requestIds,
  bodyLimit: config.sizeLimits.requestBodyBytes,
  readinessChecks: [
    { name: 'postgres', check: () => postgres.ping() },
    { name: 'redis', check: () => redis.ping() },
  ],
});
