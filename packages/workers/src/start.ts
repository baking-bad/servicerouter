import {
  readHost, readPort, readSecret, systemClock, type AppContext, type RunningApp,
} from '@servicerouter/common';
import { loadPlatformConfig } from '@servicerouter/core';
import { createPostgres } from '@servicerouter/db';
import { checkFacilitators, createFacilitators } from '@servicerouter/payments';

import { createApp } from './app.js';

export const defaultMetricsPort = 9082;
// How long the facilitators get to answer /supported at startup, as for the proxy (PR-6)
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
  // The settlement follow-up repeats settles through the enabled facilitators (WK-6)
  const facilitators = createFacilitators({
    config,
    cdpApiKey: auth => ({ id: readSecret(auth.apiKeyId, env), secret: readSecret(auth.apiKeySecret, env) }),
    clock: systemClock,
  });
  // Every enabled facilitator answers /supported, or the workers don't start (PR-6)
  await checkFacilitators({ config, facilitators, timeoutMs: facilitatorStartupTimeoutMs });

  const postgres = createPostgres({ url: databaseUrl, logger });
  const server = createApp({ config, logger, postgres, facilitators });
  try {
    await server.listen(listen);
  }
  catch (error) {
    await postgres.close();
    throw error;
  }

  return {
    close: async () => {
      await server.close();
      await postgres.close();
    },
  };
};
