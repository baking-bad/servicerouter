import { privateKeyToAccount } from 'viem/accounts';

import {
  formatUsd, InvalidEnvironmentError, readCommit, readHost, readLogLevel, readPort, readSecret, type AppContext, type AppEnvironment, type RunningApp,
  type Secret,
} from '@servicerouter/common';
import { loadPlatformConfig, platformSummary } from '@servicerouter/core';
import { createPostgres, createRedis } from '@servicerouter/db';

import { createApp } from './app.js';

export const defaultPort = 8083;
export const defaultMetricsPort = 9083;
// Long enough that guessing it over the network is hopeless
export const minimumSignerSecretLength = 32;

const readSignerSecret = (env: AppEnvironment): Secret => {
  const secret = readSecret('SIGNER_SECRET', env);
  if (secret.expose().length < minimumSignerSecretLength) {
    secret.destroy();
    throw new InvalidEnvironmentError(`SIGNER_SECRET must be at least ${minimumSignerSecretLength} characters`);
  }

  return secret;
};

/** SIGNER_BASE_KEY: the Base hot wallet's private key, `0x` and 64 hex characters (SG-1). Optional: without it, nothing is paid on Base. */
const readBaseWallet = (env: AppEnvironment) => {
  if (!env['SIGNER_BASE_KEY']?.trim())
    return undefined;
  const key = readSecret('SIGNER_BASE_KEY', env);
  try {
    const value = key.expose().trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(value))
      throw new InvalidEnvironmentError('SIGNER_BASE_KEY must be 0x and 64 hex characters');

    return privateKeyToAccount(value as `0x${string}`);
  }
  finally {
    key.destroy();
  }
};

/**
 * Wires the production dependencies from platform config and the environment, then listens (SG-1,
 * SG-2). The hot wallets' keys come from the stack's secrets. The spend counters use the Signer's own
 * Redis ACL user, from REDIS_URL (SG-5).
 */
export const startSigner = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  // LOG_LEVEL overrides the config's level (L-11)
  logger.level = readLogLevel(env, config.logger.level);
  const listen = {
    host: readHost(env),
    port: readPort(env, 'PORT', defaultPort),
    metricsPort: readPort(env, 'METRICS_PORT', defaultMetricsPort),
  };
  const secret = readSignerSecret(env);
  const base = readBaseWallet(env);
  if (!base)
    logger.warn('The Signer has no wallet: SIGNER_BASE_KEY is not set, so routed payments are refused');
  const databaseUrl = readSecret('DATABASE_URL', env);
  const redisUrl = readSecret('REDIS_URL', env);

  const postgres = createPostgres({ url: databaseUrl, logger });
  const redis = createRedis({ url: redisUrl, logger });
  const closeConnections = async () => {
    await Promise.all([postgres.close(), redis.close()]);
  };
  const server = createApp({ config, logger, postgres, redis, secret, wallets: base ? { base } : {} });
  let ports;
  try {
    ports = await server.listen(listen);
  }
  catch (error) {
    await closeConnections();
    throw error;
  }
  // L-1: once, what this Signer pays with. The wallet's public address, never its key.
  const { signer } = config;
  logger.info({
    app: 'signer',
    commit: readCommit(env) ?? null,
    logLevel: logger.level,
    environment: platformSummary(config).environment,
    wallets: { base: base?.address ?? null },
    limits: {
      maxPerCall: formatUsd(signer.maxPerCall),
      maxPerNetworkPerHour: signer.maxPerNetworkPerHour === undefined ? null : formatUsd(signer.maxPerNetworkPerHour),
      maxPerNetworkPerDay: formatUsd(signer.maxPerNetworkPerDay),
    },
    ports,
  }, 'Started');

  return {
    close: async () => {
      await server.close();
      await closeConnections();
    },
  };
};
