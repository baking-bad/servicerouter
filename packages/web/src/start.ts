import { readHost, readPort, type AppContext, type RunningApp } from '@servicerouter/common';
import { loadPlatformConfig } from '@servicerouter/core';

import { createApp } from './app.js';

export const defaultPort = 8084;
export const defaultMetricsPort = 9084;

/** Wires the production dependencies from platform config and the environment, then listens. */
export const startWeb = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  logger.level = config.logger.level;
  const listen = {
    host: readHost(env),
    port: readPort(env, 'PORT', defaultPort),
    metricsPort: readPort(env, 'METRICS_PORT', defaultMetricsPort),
  };
  const server = createApp({ config, logger });
  await server.listen(listen);

  return server;
};
