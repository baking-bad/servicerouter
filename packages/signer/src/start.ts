import { readHost, readPort, type AppContext, type RunningApp } from '@servicerouter/common';

import { createApp } from './app.js';

export const defaultPort = 8083;
export const defaultMetricsPort = 9083;

/**
 * Wires the production dependencies from the environment, then listens. The Signer depends on `common`
 * only, so it doesn't load the platform config yet.
 */
export const startSigner = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const listen = {
    host: readHost(env),
    port: readPort(env, 'PORT', defaultPort),
    metricsPort: readPort(env, 'METRICS_PORT', defaultMetricsPort),
  };
  const server = createApp({ logger });
  await server.listen(listen);

  return server;
};
