import {
  createMetricsServer, OutboundHttp, randomIdGenerator, systemClock, systemTimers, type Clock, type IdGenerator, type Logger,
  type MetricsServer, type Timers,
} from '@servicerouter/common';
import {
  createOwnershipFileFetcher, createOwnershipVerifier, cryptoRandomSource, ownershipFileLimits, type InvalidationBus, type PlatformConfig,
  type RandomSource,
} from '@servicerouter/core';
import { createLedger, createOwnershipStore, createPaymentRepository, createRedisInvalidationBus, type Postgres, type Redis } from '@servicerouter/db';
import { createAssetLookup, createFacilitatorLookup, type Facilitator, type MppSettlementCheck } from '@servicerouter/payments';

import { createHoldExpiry, holdExpiryIntervalMs, holdExpiryLockId, holdTtlMs } from './holdExpiry.js';
import { createOwnershipRecheck, ownershipRecheckJobIntervalMs, ownershipRecheckJobName, ownershipRecheckLockId } from './ownershipRecheck.js';
import { createScheduler, type Scheduler } from './scheduler.js';
import { createSettlementFollowUp, settlementFollowUpIntervalMs, settlementFollowUpLockId } from './settlementFollowUp.js';

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
  // The enabled facilitators, for the settlement follow-up (WK-6). Default: none.
  readonly facilitators?: readonly Facilitator[];
  // Reads MPP transactions' receipts on the Tempo RPC, for the settlement follow-up (WK-6). Default: none.
  readonly mppCheck?: MppSettlementCheck;
  // Redis: the invalidation channel for services whose state an ownership check changed (OV-5), and a
  // readiness check. Without it, those changes reach the proxies only when their caches expire.
  readonly redis?: Redis;
  // Where those changes are announced. Default: the Redis channel, when `redis` is given.
  readonly invalidation?: Pick<InvalidationBus, 'publish'>;
  // Fetches the hosts' ownership files (OV-2). Default: Outbound HTTP with the production address policy.
  readonly ownershipHttp?: Pick<OutboundHttp, 'request'>;
  // The ownership file's URL for a host. Default: https://<host>/.well-known/servicerouter.json.
  readonly ownershipFileUrl?: (host: string) => string;
  // Randomness for verification tokens. Default: node:crypto.
  readonly random?: RandomSource;
}

export interface WorkersServer extends MetricsServer {
  readonly scheduler: Scheduler;
}

/**
 * Workers have no public listener. Health, readiness (Postgres, and Redis when given), and metrics share
 * the metrics port. Jobs start with the listener and stop before it closes: hold expiry (LG-9),
 * settlement follow-up (WK-6), and the ownership re-check (OV-6).
 */
export const createApp = ({
  config,
  logger,
  postgres,
  clock = systemClock,
  timers = systemTimers,
  ids = randomIdGenerator,
  facilitators = [],
  mppCheck,
  redis,
  invalidation = redis ? createRedisInvalidationBus({ redis, logger }) : { publish: async () => undefined },
  ownershipHttp,
  ownershipFileUrl,
  random = cryptoRandomSource,
}: WorkersDependencies): WorkersServer => {
  const server = createMetricsServer({
    logger,
    health: true,
    readinessChecks: [
      { name: 'postgres', check: () => postgres.ping() },
      ...redis ? [{ name: 'redis', check: () => redis.ping() }] : [],
    ],
  });
  let ownedHttp: OutboundHttp | undefined;
  const fileHttp = ownershipHttp ?? (ownedHttp = new OutboundHttp({ ownHosts: config.ownHosts, connectTimeoutMs: ownershipFileLimits.connectTimeoutMs }));
  const ownershipRecheck = createOwnershipRecheck({
    verifier: createOwnershipVerifier({
      store: createOwnershipStore({ db: postgres.db, clock, ids, random }),
      fetchFile: createOwnershipFileFetcher({ http: fileHttp, ...(ownershipFileUrl ? { fileUrl: ownershipFileUrl } : {}) }),
      clock,
      invalidation,
      logger,
    }),
  });
  const payments = createPaymentRepository({ db: postgres.db, clock });
  const ledger = createLedger({ db: postgres.db, clock, ids });
  const holdExpiry = createHoldExpiry({ payments, ledger, clock, ttlMs: holdTtlMs(config), feeBps: config.feeBps, logger });
  const settlementFollowUp = createSettlementFollowUp({
    payments,
    ledger,
    facilitatorFor: facilitators.length > 0 ? createFacilitatorLookup(config, facilitators) : () => undefined,
    assetName: createAssetLookup(config),
    ...(mppCheck ? { mppCheck } : {}),
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
    }, {
      name: 'settlement_follow_up',
      lockId: settlementFollowUpLockId,
      intervalMs: settlementFollowUpIntervalMs,
      run: async () => {
        await settlementFollowUp();
      },
    }, {
      name: ownershipRecheckJobName,
      lockId: ownershipRecheckLockId,
      intervalMs: ownershipRecheckJobIntervalMs,
      run: async () => {
        await ownershipRecheck();
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
      await ownedHttp?.close();
    },
  };
};
