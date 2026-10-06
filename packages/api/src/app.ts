import { createServer, type IdGenerator, type Logger, type Server } from '@servicerouter/common';
import type { PlatformConfig } from '@servicerouter/core';
import type { Postgres, Redis } from '@servicerouter/db';

import { errorStatuses } from './errors.js';

export interface ApiDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly postgres: Postgres;
  readonly redis: Redis;
  // Request IDs for requests without one. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
}

/** The Platform API on api.servicerouter.ai. Readiness covers Postgres and Redis (PA-6). */
export const createApp = ({ logger, postgres, redis, requestIds }: ApiDependencies): Server => createServer({
  logger,
  errorStatuses,
  requestIds,
  readinessChecks: [
    { name: 'postgres', check: () => postgres.ping() },
    { name: 'redis', check: () => redis.ping() },
  ],
});
