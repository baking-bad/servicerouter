import {
  readHost, readPort, readSecret, type AppContext, type RunningApp,
} from '@servicerouter/common';
import { loadPlatformConfig } from '@servicerouter/core';
import { createPostgres, createRedis } from '@servicerouter/db';

import { createApp } from './app.js';
import { readSecretsSealer } from './services/keys.js';

export const defaultPort = 8081;
export const defaultMetricsPort = 9081;

/** Wires the production dependencies from platform config and the environment, then listens. */
export const startApi = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  logger.level = config.logger.level;
  const listen = {
    host: readHost(env),
    port: readPort(env, 'PORT', defaultPort),
    metricsPort: readPort(env, 'METRICS_PORT', defaultMetricsPort),
  };
  // Traefik's addresses or CIDR ranges, comma-separated, so the signup limit sees the client IP (PA-5)
  const trustProxy = env['TRUST_PROXY']?.trim() || undefined;
  const databaseUrl = readSecret('DATABASE_URL', env);
  const redisUrl = readSecret('REDIS_URL', env);
  // Missing or unusable, the app stops here with the reason (S2-D4)
  const sealer = readSecretsSealer(env);

  const postgres = createPostgres({ url: databaseUrl, logger });
  const redis = createRedis({ url: redisUrl, logger });
  const closeConnections = async () => {
    await Promise.all([postgres.close(), redis.close()]);
  };
  const server = createApp({ config, logger, postgres, redis, trustProxy, sealer });
  try {
    await server.listen(listen);
  }
  catch (error) {
    await closeConnections();
    throw error;
  }

  return {
    close: async () => {
      await server.close();
      await closeConnections();
    },
  };
};
