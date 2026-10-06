import {
  readCommit, readHost, readLogLevel, readPort, readSecret, type AppContext, type RunningApp,
} from '@servicerouter/common';
import { loadPlatformConfig, platformSummary } from '@servicerouter/core';
import { createPostgres, createRedis } from '@servicerouter/db';

import { createApp } from './app.js';
import { readDepositAddresses } from './deposits/key.js';
import { readInternalSecret } from './internal/secret.js';
import { readCorsOrigins } from './cors.js';
import { readSecretsSealer } from './services/keys.js';

export const defaultPort = 8081;
export const defaultMetricsPort = 9081;
// The internal API (PA-4): no Traefik labels and no published port, so only the internal network reaches it
export const defaultInternalPort = 8082;

/** Wires the production dependencies from platform config and the environment, then listens. */
export const startApi = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  // LOG_LEVEL overrides the config's level (L-11)
  logger.level = readLogLevel(env, config.logger.level);
  const listen = {
    host: readHost(env),
    port: readPort(env, 'PORT', defaultPort),
    metricsPort: readPort(env, 'METRICS_PORT', defaultMetricsPort),
    internalPort: readPort(env, 'INTERNAL_PORT', defaultInternalPort),
  };
  // Traefik's addresses or CIDR ranges, comma-separated, so the signup limit sees the client IP (PA-5)
  const trustProxy = env['TRUST_PROXY']?.trim() || undefined;
  // The website's origin, and local development's (PA-7)
  const corsOrigins = readCorsOrigins(env, config.urls.website);
  const databaseUrl = readSecret('DATABASE_URL', env);
  const redisUrl = readSecret('REDIS_URL', env);
  // Missing or unusable, the app stops here with the reason (S2-D4)
  const sealer = readSecretsSealer(env);
  const internalSecret = readInternalSecret(env);
  // DP-1: required while deposits are on
  const depositAddresses = config.deposits ? readDepositAddresses(env, config.deposits) : undefined;

  const postgres = createPostgres({ url: databaseUrl, logger });
  const redis = createRedis({ url: redisUrl, logger });
  const closeConnections = async () => {
    await Promise.all([postgres.close(), redis.close()]);
  };
  const server = createApp({
    config, logger, postgres, redis, trustProxy, sealer, internalSecret, corsOrigins, ...(depositAddresses ? { depositAddresses } : {}),
  });
  let ports;
  try {
    ports = await server.listen(listen);
  }
  catch (error) {
    await closeConnections();
    throw error;
  }
  // L-1: once, what this replica runs with. Names, networks, URLs, and origins: never a secret or a key.
  logger.info({
    app: 'api',
    commit: readCommit(env) ?? null,
    logLevel: logger.level,
    ...platformSummary(config),
    // Signup creates deposit addresses only with DEPOSIT_ACCOUNT_PUBLIC_KEY (DP-1)
    depositAddresses: depositAddresses !== undefined,
    corsOrigins,
    ports,
  }, 'Started');

  return {
    close: async () => {
      await server.close();
      await closeConnections();
    },
  };
};
