import { Gauge, type Registry } from '@prometheus-io/client';

import { formatUsd, type Clock, type IdGenerator, type Logger, type MicroUsd } from '@servicerouter/common';
import { atomicToUsd, reconcile, type Asset, type BalanceReader, type PlatformConfig, type TreasuryWallet } from '@servicerouter/core';
import { ledgerAccountIds, reconciliationRuns, type Database, type Ledger, type PayoutRepository } from '@servicerouter/db';

// WK-1: one runner across replicas
export const treasuryBalancesLockId = 7_301_746_206;
export const reconciliationLockId = 7_301_746_207;
// TR-3: every few minutes. TR-5: daily.
export const treasuryBalancesIntervalMs = 5 * 60_000;
export const reconciliationIntervalMs = 24 * 60 * 60_000;
export const treasuryBalancesJobName = 'treasury_balances';
export const reconciliationJobName = 'reconciliation';

export interface TreasuryMetrics {
  readonly balance: Gauge<'wallet' | 'asset'>;
  readonly drift: Gauge<'asset'>;
}

export const createTreasuryMetrics = (registry: Registry): TreasuryMetrics => ({
  balance: new Gauge({
    name: 'treasury_balance_usd',
    help: 'What each platform wallet holds of each asset, in USD (TR-3)',
    labelNames: ['wallet', 'asset'] as const,
    registers: [registry],
  }),
  drift: new Gauge({
    name: 'treasury_drift_usd',
    help: 'On-chain holdings minus what the ledger says, per asset, at the last reconciliation (TR-5)',
    labelNames: ['asset'] as const,
    registers: [registry],
  }),
});

/** A wallet's holdings per asset, in micro-USD. An asset without a reader, or that failed, is left out. */
const holdingsOf = async (wallet: TreasuryWallet, readerFor: (asset: Asset) => BalanceReader | undefined, logger: Logger): Promise<{ readonly held: Map<string, MicroUsd>; readonly failed: number }> => {
  const held = new Map<string, MicroUsd>();
  let failed = 0;
  for (const asset of wallet.assets) {
    const reader = readerFor(asset);
    if (!reader)
      continue;
    for (const address of wallet.addresses) {
      try {
        const quantity = await reader.balance({ address, asset });
        held.set(asset.name, ((held.get(asset.name) ?? 0n) + atomicToUsd(quantity, asset.decimals)) as MicroUsd);
      }
      catch (error) {
        failed += 1;
        // An RPC's error is reduced to its short message: never the RPC's URL or request (L-9)
        logger.error({ error, wallet: wallet.name, asset: asset.name, network: asset.network.id }, 'Failed to read a treasury balance');
      }
    }
  }

  return { held, failed };
};

/**
 * Warns about each empty `payTo` that has no token account for its asset (Solana): x402's `exact`
 * payment there only transfers, so buyers' payments fail until the account exists. Returns how many
 * checks failed.
 */
const warnWithoutTokenAccounts = async (wallet: TreasuryWallet, held: ReadonlyMap<string, MicroUsd>, readerFor: (asset: Asset) => BalanceReader | undefined, logger: Logger): Promise<number> => {
  let failed = 0;
  for (const asset of wallet.assets) {
    const reader = readerFor(asset);
    // Only an empty balance can lack the account: a read that failed has no entry
    if (!reader?.hasTokenAccount || held.get(asset.name) !== 0n)
      continue;
    for (const address of wallet.addresses) {
      try {
        if (!await reader.hasTokenAccount({ address, asset }))
          logger.warn({ wallet: wallet.name, asset: asset.name, network: asset.network.id, address, alert: true }, 'A payTo has no token account for its asset: payments to it fail until it has one');
      }
      catch (error) {
        failed += 1;
        logger.error({ error, wallet: wallet.name, asset: asset.name, network: asset.network.id }, 'Failed to read a treasury balance');
      }
    }
  }

  return failed;
};

/**
 * The balance monitor (TR-3): each wallet's holdings as a metric. Alerts when the payout wallet won't
 * cover a run that waits for it, warns when a Signer wallet holds less than a day's spend limit, and
 * warns when a Solana `payTo` has no token account. A balance that can't be read fails the run, so the
 * job goes stale.
 */
export const createTreasuryBalancesJob = ({ wallets, readerFor, payouts, signerDailyLimit, metrics, logger }: {
  readonly wallets: () => Promise<readonly TreasuryWallet[]>;
  readonly readerFor: (asset: Asset) => BalanceReader | undefined;
  readonly payouts: Pick<PayoutRepository, 'runsWithStatus'> | undefined;
  // signer.maxPerNetworkPerDay: a hot wallet below it may run dry within a day (TR-3, SG-9)
  readonly signerDailyLimit: MicroUsd;
  readonly metrics: TreasuryMetrics;
  readonly logger: Logger;
}) => async (): Promise<{ readonly wallets: number; readonly balances: number }> => {
  let failed = 0;
  let read = 0;
  const watched = (await wallets()).filter(item => item.role !== 'deposits');
  for (const wallet of watched) {
    const result = await holdingsOf(wallet, readerFor, logger);
    failed += result.failed;
    read += result.held.size;
    for (const [asset, amount] of result.held)
      metrics.balance.set({ wallet: wallet.name, asset }, Number(formatUsd(amount)));
    if (wallet.role === 'pay_to')
      failed += await warnWithoutTokenAccounts(wallet, result.held, readerFor, logger);

    if (wallet.role === 'payout' && payouts) {
      const due = (await payouts.runsWithStatus(['awaiting_approval', 'approved'])).reduce((sum, run) => sum + run.total, 0n);
      const held = [...result.held.values()].reduce((sum, amount) => sum + amount, 0n);
      if (due > held)
        logger.error({ wallet: wallet.name, due: formatUsd(due as MicroUsd), held: formatUsd(held as MicroUsd), alert: true }, 'The payout wallet won\'t cover the next payout run');
    }
    // TR-3: a hot wallet that read fine, but holds less than a day of routed payments
    if (wallet.role === 'signer' && result.held.size > 0) {
      const held = [...result.held.values()].reduce((sum, amount) => sum + amount, 0n);
      if (held < signerDailyLimit)
        logger.warn({ wallet: wallet.name, held: formatUsd(held as MicroUsd), dailyLimit: formatUsd(signerDailyLimit), alert: true }, 'A Signer wallet holds less than a day\'s spend limit: top it up');
    }
  }
  if (failed > 0)
    throw new Error(`${failed} treasury balances couldn't be read`);

  return { wallets: watched.length, balances: read };
};

/**
 * Reconciliation (TR-5): per asset, the ledger's view of what the platform holds against the chain's,
 * deposit addresses included. Each run is stored. A drift above the threshold alerts. The Signer's hot
 * wallets aren't counted: the operator funds them outside the ledger, so their balances would move
 * every total by what they hold.
 */
export const createReconciliationJob = ({ db, config, wallets, readerFor, ledger, metrics, clock, ids, logger }: {
  readonly db: Database;
  readonly config: PlatformConfig;
  readonly wallets: () => Promise<readonly TreasuryWallet[]>;
  readonly readerFor: (asset: Asset) => BalanceReader | undefined;
  readonly ledger: Pick<Ledger, 'balancesOf'>;
  readonly metrics: TreasuryMetrics;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}) => async (): Promise<{ readonly assets: number; readonly alerts: number }> => {
  const chain = new Map<string, MicroUsd>();
  let failed = 0;
  for (const wallet of (await wallets()).filter(item => item.role !== 'signer')) {
    const result = await holdingsOf(wallet, readerFor, logger);
    failed += result.failed;
    for (const [asset, amount] of result.held)
      chain.set(asset, ((chain.get(asset) ?? 0n) + amount) as MicroUsd);
  }
  if (failed > 0)
    throw new Error(`${failed} treasury balances couldn't be read: no reconciliation without them`);

  const readable = config.assets.filter(asset => readerFor(asset) !== undefined);
  const ledgerBalances = await ledger.balancesOf([...readable.map(asset => ledgerAccountIds.treasury(asset.name)), ledgerAccountIds.depositsClearing]);
  const results = reconcile({ assets: readable, ledgerBalances, chainBalances: chain, depositAsset: config.deposits?.asset.name });
  let alerts = 0;
  for (const [asset, entry] of results) {
    metrics.drift.set({ asset }, Number(formatUsd(entry.drift)));
    if (entry.alert) {
      alerts += 1;
      logger.error({ asset, ledger: formatUsd(entry.ledger), chain: formatUsd(entry.chain), drift: formatUsd(entry.drift), alert: true }, 'Treasury drift: the chain and the ledger disagree');
    }
  }
  await db.insert(reconciliationRuns).values({
    id: `rec_${ids.next()}`,
    ranAt: clock.now(),
    results: Object.fromEntries([...results].map(([asset, entry]) => [asset, {
      ledger: formatUsd(entry.ledger), chain: formatUsd(entry.chain), drift: formatUsd(entry.drift), alert: entry.alert,
    }])),
    alerts,
  });

  return { assets: results.size, alerts };
};
