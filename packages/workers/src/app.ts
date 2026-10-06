import { createMetricsServer, type Logger, type MetricsServer } from '@servicerouter/common';
import type { PlatformConfig } from '@servicerouter/core';
import type { Postgres } from '@servicerouter/db';

export interface WorkersDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly postgres: Postgres;
}

/**
 * Workers have no public listener. Health, readiness (Postgres), and metrics share the metrics port.
 * Jobs arrive in later steps.
 */
export const createApp = ({ logger, postgres }: WorkersDependencies): MetricsServer => createMetricsServer({
  logger,
  health: true,
  readinessChecks: [{ name: 'postgres', check: () => postgres.ping() }],
});
