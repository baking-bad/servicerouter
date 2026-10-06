import {
  readHost, readPort, readSecret, type AppContext, type RunningApp,
} from '@servicerouter/common';
import { loadPlatformConfig } from '@servicerouter/core';
import { createPostgres, createRedis } from '@servicerouter/db';

import { createApp } from './app.js';

export const defaultPort = 8080;
export const defaultMetricsPort = 9080;

/** Wires the production dependencies from platform config and the environment, then listens. */
export const startProxy = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  logger.level = config.logger.level;
  const listen = {
    host: readHost(env),
    port: readPort(env, 'PORT', defaultPort),
    metricsPort: readPort(env, 'METRICS_PORT', defaultMetricsPort),
  };
  const databaseUrl = readSecret('DATABASE_URL', env);
  const redisUrl = readSecret('REDIS_URL', env);

  const postgres = createPostgres({ url: databaseUrl, logger });
  const redis = createRedis({ url: redisUrl, logger });
  const closeConnections = async () => {
    await Promise.all([postgres.close(), redis.close()]);
  };
  const server = createApp({ config, logger, postgres, redis });
  try {
    await server.listen(listen);
  }
  catch (error) {
    await closeConnections();
    throw error;
  }

  // Drains in-flight requests before closing the pools (PX-18)
  return {
    close: async () => {
      await server.close();
      await closeConnections();
    },
  };
};
