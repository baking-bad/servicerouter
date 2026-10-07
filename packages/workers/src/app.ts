import {
  createMetricsServer, OutboundHttp, randomIdGenerator, systemClock, systemTimers, type Clock, type IdGenerator, type Logger,
  type MetricsServer, type Timers,
} from '@servicerouter/common';
import {
  createOwnershipFileFetcher, createOwnershipVerifier, cryptoRandomSource, facilitatorFee, findAsset, ownershipFileLimits, treasuryWallets, type BalanceReader,
  type BlockfrostClient, type InvalidationBus, type PlatformConfig, type RandomSource,
} from '@servicerouter/core';
import {
  createCatalogRepository, createDepositRepository, createLedger, createOwnershipStore, createPaymentRepository, createPayoutRepository,
  createRedisInvalidationBus, createRoutingRepository, depositAddresses, type Postgres, type Redis,
} from '@servicerouter/db';
import { createAssetLookup, createFacilitatorLookup, type Facilitator, type MppSettlementCheck } from '@servicerouter/payments';

import {
  catalogIndexIntervalMs, catalogIndexJobName, catalogIndexLockId, createCatalogIndex, createServiceStats, serviceStatsIntervalMs, serviceStatsJobName,
  serviceStatsLockId,
} from './catalog.js';
import { createDepositWatcherJob, depositWatcherIntervalMs, depositWatcherJobName, depositWatcherLockId } from './depositWatcher.js';
import { createHoldExpiry, holdExpiryIntervalMs, holdExpiryLockId, holdTtlMs } from './holdExpiry.js';
import { createOwnershipRecheck, ownershipRecheckJobIntervalMs, ownershipRecheckJobName, ownershipRecheckLockId } from './ownershipRecheck.js';
import { createPayoutsJob, payoutsIntervalMs, payoutsJobName, payoutsLockId } from './payouts/job.js';
import type { PayoutWallet } from './payouts/wallet.js';
import {
  createReconciliationJob, createTreasuryBalancesJob, createTreasuryMetrics, reconciliationIntervalMs, reconciliationJobName, reconciliationLockId,
  treasuryBalancesIntervalMs, treasuryBalancesJobName, treasuryBalancesLockId,
} from './treasury/jobs.js';
import { readerFor } from './treasury/readers.js';
import { createScheduler, type JobOutcome, type Scheduler } from './scheduler.js';
import { createRoutingLossMetrics, createRoutingLosses, routingLossesIntervalMs, routingLossesJobName, routingLossesLockId } from './routingLosses.js';
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
  // Reads deposit addresses' transactions (DP-2) and submits payouts (PO-3). The deposit watcher runs only with it, while deposits are on.
  readonly blockfrost?: BlockfrostClient;
  // The payout wallet, with the payout key (PO-8). The payouts job runs only with it and Blockfrost.
  readonly payoutWallet?: PayoutWallet;
  // Balance readers per chain (TR-3, TR-5). The treasury jobs run only with one.
  readonly balanceReaders?: { readonly cardano?: BalanceReader; readonly evm?: BalanceReader; readonly solana?: BalanceReader };
}

export interface WorkersServer extends MetricsServer {
  readonly scheduler: Scheduler;
  // The jobs this replica runs, for its startup line (L-1)
  readonly jobs: readonly string[];
}

// A run's counts, for its log line: it did something when any of `acted` is above 0 (L-8)
const outcomeOf = <TCounts extends { readonly [Name in keyof TCounts]: number | string | boolean | null | undefined }>(
  counts: TCounts, acted: readonly (keyof TCounts & string)[],
): JobOutcome => {
  const values: Readonly<Record<string, number | string | boolean | null | undefined>> = counts;

  return {
    counts: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value ?? null])),
    acted: acted.some(name => typeof values[name] === 'number' ? values[name] > 0 : values[name] !== undefined && values[name] !== null),
  };
};

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
  blockfrost,
  payoutWallet,
  balanceReaders,
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
    feePerPayment: network => facilitatorFee(config, network),
    logger,
  });
  const routingLosses = createRoutingLosses({
    routing: createRoutingRepository({ db: postgres.db, clock }), ledger, metrics: createRoutingLossMetrics(server.registry), logger,
  });
  const depositWatcher = config.deposits && blockfrost
    ? createDepositWatcherJob({ store: createDepositRepository({ db: postgres.db, clock, ids }), blockfrost, clock, logger, deposits: config.deposits })
    : undefined;
  const payoutAsset = config.payouts.assets[0] === undefined ? undefined : findAsset(config, config.payouts.assets[0]);
  const payoutRepository = createPayoutRepository({ db: postgres.db, clock, ids });
  const payoutsJob = payoutWallet && blockfrost && payoutAsset
    ? createPayoutsJob({
      repository: payoutRepository, wallet: payoutWallet, blockfrost, clock, ids, logger, asset: payoutAsset, minimum: config.payouts.minimum,
      // PO-6, AR10: mainnet runs wait for an operator
      needsApproval: config.environment === 'production',
    })
    : undefined;
  const pickReader = readerFor(balanceReaders ?? {});
  const wallets = async () => treasuryWallets(config, {
    ...payoutWallet ? { payoutAddress: payoutWallet.address } : {},
    depositAddresses: (await postgres.db.select({ address: depositAddresses.address }).from(depositAddresses)).map(row => row.address),
  });
  const treasuryJobs = balanceReaders && (balanceReaders.cardano || balanceReaders.evm || balanceReaders.solana)
    ? (() => {
      const metrics = createTreasuryMetrics(server.registry);

      return {
        balances: createTreasuryBalancesJob({
          wallets, readerFor: pickReader, payouts: payoutRepository, signerDailyLimit: config.signer.maxPerNetworkPerDay, metrics, logger,
        }),
        reconciliation: createReconciliationJob({ db: postgres.db, config, wallets, readerFor: pickReader, ledger, metrics, clock, ids, logger }),
      };
    })()
    : undefined;
  const catalog = createCatalogRepository({ db: postgres.db, clock });
  const catalogIndex = createCatalogIndex({ db: postgres.db, catalog, config, logger });
  const serviceStats = createServiceStats({ catalog, clock });
  // Each run returns its counts; `acted` names those that make its line info (L-8)
  const jobs = [{
    name: 'hold_expiry',
    lockId: holdExpiryLockId,
    intervalMs: holdExpiryIntervalMs,
    run: async () => outcomeOf(await holdExpiry(), ['captured', 'released']),
  }, {
    name: 'settlement_follow_up',
    lockId: settlementFollowUpLockId,
    intervalMs: settlementFollowUpIntervalMs,
    // Pending ones wait for the next run: polling them isn't news
    run: async () => outcomeOf(await settlementFollowUp(), ['settled', 'failed']),
  }, {
    name: routingLossesJobName,
    lockId: routingLossesLockId,
    intervalMs: routingLossesIntervalMs,
    run: async () => outcomeOf(await routingLosses(), ['booked']),
  }, {
    name: ownershipRecheckJobName,
    lockId: ownershipRecheckLockId,
    intervalMs: ownershipRecheckJobIntervalMs,
    run: async () => outcomeOf(await ownershipRecheck(), ['hosts', 'confirmations', 'expired']),
  }, {
    name: catalogIndexJobName,
    lockId: catalogIndexLockId,
    intervalMs: catalogIndexIntervalMs,
    // A refresh every minute: debug
    run: async () => outcomeOf({ entries: await catalogIndex() }, []),
  }, {
    name: serviceStatsJobName,
    lockId: serviceStatsLockId,
    intervalMs: serviceStatsIntervalMs,
    run: async () => outcomeOf({ rows: await serviceStats() }, []),
  }, ...depositWatcher ? [{
    name: depositWatcherJobName,
    lockId: depositWatcherLockId,
    intervalMs: depositWatcherIntervalMs,
    run: async () => outcomeOf(await depositWatcher(), ['recorded', 'credited', 'dropped']),
  }] : [], ...payoutsJob ? [{
    name: payoutsJobName,
    lockId: payoutsLockId,
    intervalMs: payoutsIntervalMs,
    run: async () => outcomeOf(await payoutsJob(), ['built', 'submitted', 'confirmed', 'failed']),
  }] : [], ...treasuryJobs ? [{
    name: treasuryBalancesJobName,
    lockId: treasuryBalancesLockId,
    intervalMs: treasuryBalancesIntervalMs,
    run: async () => outcomeOf(await treasuryJobs.balances(), []),
  }, {
    name: reconciliationJobName,
    lockId: reconciliationLockId,
    intervalMs: reconciliationIntervalMs,
    // Daily: always news
    run: async () => outcomeOf(await treasuryJobs.reconciliation(), ['assets']),
  }] : []];
  const scheduler = createScheduler({
    jobs,
    locks: postgres,
    clock,
    timers,
    logger,
    registry: server.registry,
  });

  return {
    ...server,
    scheduler,
    jobs: jobs.map(job => job.name),
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
