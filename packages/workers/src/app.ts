import {
  createMetricsServer, randomIdGenerator, systemClock, systemTimers, type Clock, type IdGenerator, type Logger, type MetricsServer,
  type Timers,
} from '@servicerouter/common';
import type { PlatformConfig } from '@servicerouter/core';
import { createLedger, createPaymentRepository, type Postgres } from '@servicerouter/db';

import { createHoldExpiry, holdExpiryIntervalMs, holdExpiryLockId, holdTtlMs } from './holdExpiry.js';
import { createScheduler, type Scheduler } from './scheduler.js';

export interface WorkersDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly postgres: Postgres;
  // Job time (WK-3). Default: the system clock.
  readonly clock?: Clock;
  // Job schedules. Default: Node's timers.
  readonly timers?: Timers;
  // Ledger IDs. Default: random UUIDs.
  readonly ids?: IdGenerator;
}

export interface WorkersServer extends MetricsServer {
  readonly scheduler: Scheduler;
}

/**
 * Workers have no public listener. Health, readiness (Postgres), and metrics share the metrics port.
 * Jobs start with the listener and stop before it closes. Step 4: hold expiry (LG-9).
 */
export const createApp = ({
  config,
  logger,
  postgres,
  clock = systemClock,
  timers = systemTimers,
  ids = randomIdGenerator,
}: WorkersDependencies): WorkersServer => {
  const server = createMetricsServer({
    logger,
    health: true,
    readinessChecks: [{ name: 'postgres', check: () => postgres.ping() }],
  });
  const holdExpiry = createHoldExpiry({
    payments: createPaymentRepository({ db: postgres.db, clock }),
    ledger: createLedger({ db: postgres.db, clock, ids }),
    clock,
    ttlMs: holdTtlMs(config),
    feeBps: config.feeBps,
    logger,
  });
  const scheduler = createScheduler({
    jobs: [{
      name: 'hold_expiry',
      lockId: holdExpiryLockId,
      intervalMs: holdExpiryIntervalMs,
      run: async () => {
        await holdExpiry();
      },
    }],
    locks: postgres,
    clock,
    timers,
    logger,
    registry: server.registry,
  });

  return {
    ...server,
    scheduler,
    listen: async options => {
      const port = await server.listen(options);
      scheduler.start();

      return port;
    },
    close: async () => {
      await scheduler.stop();
      await server.close();
    },
  };
};
