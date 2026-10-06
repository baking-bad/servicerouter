import {
  readHost, readPort, readSecret, systemClock, type AppContext, type RunningApp,
} from '@servicerouter/common';
import { loadPlatformConfig } from '@servicerouter/core';
import { createPostgres, createRedis, createRedisReplayStore } from '@servicerouter/db';
import { createFacilitators, initializeMpp, initializeX402, type MppSetup } from '@servicerouter/payments';

import { createApp } from './app.js';
import { readSecretsOpener } from './keys.js';
import { readBuyerHeaderKey } from './payments/buyer.js';
import { createSignerClient } from './routing/support.js';
import { readMppSecretKey } from './payments/mpp.js';

export const defaultPort = 8080;
export const defaultMetricsPort = 9080;
// How long the facilitators get to answer /supported at startup (PR-6), and the Tempo RPC its chain ID (PR-9)
export const facilitatorStartupTimeoutMs = 10_000;

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
  // Payment routing (RT-7, RT-12): the Signer and the internal API, on the internal network. Without
  // the Signer, routed calls answer 503 and nobody pays.
  const signerUrl = env['SIGNER_URL']?.trim();
  const signer = signerUrl
    ? createSignerClient({ url: signerUrl, secret: readSecret('SIGNER_SECRET', env), timeoutMs: config.timeouts.connectMs })
    : undefined;
  const internalApiUrl = env['INTERNAL_API_URL']?.trim();
  const internalApi = internalApiUrl ? { url: internalApiUrl, secret: readSecret('INTERNAL_API_SECRET', env) } : undefined;
  if (!signer)
    logger.warn('Payment routing pays no targets: SIGNER_URL is not set');
  // Traefik's addresses or CIDR ranges, comma-separated, so the unpaid limit sees the client IP (PX-13)
  const trustProxy = env['TRUST_PROXY']?.trim() || undefined;
  // The MPP challenges' HMAC key (PR-9). Not read while MPP is off.
  const mppSecretKey = config.mpp.enabled ? readMppSecretKey(env) : undefined;
  // x402 (PR-6): every enabled facilitator answers /supported, or the proxy doesn't start
  const x402 = config.facilitators.some(facilitator => facilitator.enabled)
    ? await initializeX402({
      config,
      facilitators: createFacilitators({
        config,
        // The CDP API key, by the names platform config gives (PC-3)
        cdpApiKey: auth => ({ id: readSecret(auth.apiKeyId, env), secret: readSecret(auth.apiKeySecret, env) }),
        clock: systemClock,
      }),
      timeoutMs: facilitatorStartupTimeoutMs,
    })
    : undefined;

  const postgres = createPostgres({ url: databaseUrl, logger });
  const redis = createRedis({ url: redisUrl, logger });
  // The MPP replay store, shared by every replica (section 5)
  const replayStore = createRedisReplayStore({ redis });
  const closeConnections = async () => {
    await replayStore.close();
    await Promise.all([postgres.close(), redis.close()]);
  };
  // MPP (PR-9): the Tempo RPC answers with mpp.network's chain ID, or the proxy doesn't start
  let mpp: MppSetup | undefined;
  try {
    if (mppSecretKey)
      mpp = await initializeMpp({ config, secretKey: mppSecretKey, store: replayStore, timeoutMs: facilitatorStartupTimeoutMs });
  }
  catch (error) {
    await closeConnections();
    throw error;
  }
  const server = createApp({
    config, logger, postgres, redis, opener, buyerHeaderKey, trustProxy, x402, mpp, ...signer ? { signer } : {}, ...internalApi ? { internalApi } : {},
  });
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
