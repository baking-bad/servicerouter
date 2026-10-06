import {
  readHost, readPort, readSecret, systemClock, type AppContext, type RunningApp,
} from '@servicerouter/common';
import { loadPlatformConfig } from '@servicerouter/core';
import { createPostgres, createRedis } from '@servicerouter/db';
import { checkFacilitators, createFacilitators, createMppSettlementCheck, createTempoRpc, type MppSettlementCheck } from '@servicerouter/payments';

import { createApp } from './app.js';

export const defaultMetricsPort = 9082;
// How long the facilitators get to answer /supported at startup, as for the proxy (PR-6), and the Tempo
// RPC its chain ID (PR-9)
export const facilitatorStartupTimeoutMs = 10_000;

/** Wires the production dependencies from platform config and the environment, then listens. */
export const startWorkers = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  logger.level = config.logger.level;
  const listen = {
    host: readHost(env),
    port: readPort(env, 'METRICS_PORT', defaultMetricsPort),
  };
  const databaseUrl = readSecret('DATABASE_URL', env);
  // The invalidation channel, for services an ownership check changes (OV-5)
  const redisUrl = readSecret('REDIS_URL', env);
  // The settlement follow-up repeats settles through the enabled facilitators (WK-6)
  const facilitators = createFacilitators({
    config,
    cdpApiKey: auth => ({ id: readSecret(auth.apiKeyId, env), secret: readSecret(auth.apiKeySecret, env) }),
    clock: systemClock,
  });
  // Every enabled facilitator answers /supported, or the workers don't start (PR-6)
  await checkFacilitators({ config, facilitators, timeoutMs: facilitatorStartupTimeoutMs });
  // While MPP is on, the follow-up reads receipts on the Tempo RPC, which must answer with mpp.network's
  // chain ID (PR-9, WK-6)
  let mppCheck: MppSettlementCheck | undefined;
  if (config.mpp.enabled) {
    const rpc = createTempoRpc({ network: config.mpp.network, url: config.mpp.rpcUrl });
    await rpc.check(facilitatorStartupTimeoutMs);
    mppCheck = createMppSettlementCheck({ rpc, timeoutMs: config.timeouts.connectMs, clock: systemClock });
  }

  const postgres = createPostgres({ url: databaseUrl, logger });
  const redis = createRedis({ url: redisUrl, logger });
  const closeConnections = async () => {
    await Promise.all([postgres.close(), redis.close()]);
  };
  const server = createApp({ config, logger, postgres, redis, facilitators, ...(mppCheck ? { mppCheck } : {}) });
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
