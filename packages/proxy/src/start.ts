import {
  readHost, readPort, readSecret, type AppContext, type RunningApp,
} from '@servicerouter/common';
import { loadPlatformConfig } from '@servicerouter/core';
import { createPostgres, createRedis } from '@servicerouter/db';

import { createApp } from './app.js';
import { readSecretsOpener } from './keys.js';
import { readBuyerHeaderKey } from './payments/buyer.js';

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
  // Missing or unusable, the app stops here with the reason (SC-4, S2-D4)
  const opener = readSecretsOpener(env);
  // The buyer header's HMAC key (PX-15)
  const buyerHeaderKey = readBuyerHeaderKey(env);
  // Traefik's addresses or CIDR ranges, comma-separated, so the unpaid limit sees the client IP (PX-13)
  const trustProxy = env['TRUST_PROXY']?.trim() || undefined;

  const postgres = createPostgres({ url: databaseUrl, logger });
  const redis = createRedis({ url: redisUrl, logger });
  const closeConnections = async () => {
    await Promise.all([postgres.close(), redis.close()]);
  };
  const server = createApp({ config, logger, postgres, redis, opener, buyerHeaderKey, trustProxy });
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
