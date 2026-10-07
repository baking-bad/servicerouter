import type { MicroUsd } from '@servicerouter/common';

import type { Asset, PlatformConfig } from '../platform/config.js';

/** A platform wallet and the assets it holds (TR-1). */
export interface TreasuryWallet {
  // Such as `payTo:base-usdc`, `payout`, `deposits`, or `signer:tempo`
  readonly name: string;
  // `signer`: a hot wallet that pays routed targets (SG-1). The balance monitor watches it; reconciliation doesn't count it.
  readonly role: 'pay_to' | 'payout' | 'deposits' | 'signer';
  readonly addresses: readonly string[];
  readonly assets: readonly Asset[];
}

/** Port: reads what an address holds of an asset, in its atomic units. One per chain. */
export interface BalanceReader {
  balance(input: { readonly address: string; readonly asset: Asset }): Promise<bigint>;
  /**
   * Solana only: whether the address has a token account for the asset. x402's `exact` payment on
   * Solana only transfers, so a `payTo` without one can't be paid. Absent on chains without token accounts.
   */
  hasTokenAccount?(input: { readonly address: string; readonly asset: Asset }): Promise<boolean>;
}

/**
 * Every platform wallet (TR-1), from platform config: each asset's `payTo` (which is the MPP
 * recipient for Tempo assets), the payout wallet, the deposit addresses, and the Signer's hot wallets
 * from `signer.wallets`, each with the registry's assets on its chain: Base's, and `mpp.network`'s for
 * Tempo. Keys stay offline for receiving addresses (TR-2).
 */
export const treasuryWallets = (config: PlatformConfig, extra: {
  readonly payoutAddress?: string;
  readonly depositAddresses?: readonly string[];
} = {}): readonly TreasuryWallet[] => {
  const payTo = new Map<string, { addresses: string[]; assets: Asset[] }>();
  for (const asset of config.assets) {
    const key = `${asset.network.id}:${asset.payTo}`;
    const wallet = payTo.get(key) ?? { addresses: [asset.payTo], assets: [] };
    wallet.assets.push(asset);
    payTo.set(key, wallet);
  }
  const payoutAssets = config.assets.filter(asset => config.payouts.assets.includes(asset.name));
  const { base, tempo } = config.signer.wallets;
  const signerWallets = [
    { chain: 'base', address: base, assets: config.assets.filter(asset => asset.network.chain === 'base') },
    { chain: 'tempo', address: tempo, assets: config.assets.filter(asset => asset.network.id === config.mpp.network.id) },
  ].filter(wallet => wallet.address !== undefined && wallet.assets.length > 0);

  return [
    ...[...payTo.values()].map(wallet => ({ name: `payTo:${wallet.assets.map(asset => asset.name).join('+')}`, role: 'pay_to' as const, ...wallet })),
    ...extra.payoutAddress ? [{ name: 'payout', role: 'payout' as const, addresses: [extra.payoutAddress], assets: payoutAssets }] : [],
    ...config.deposits && extra.depositAddresses && extra.depositAddresses.length > 0
      ? [{ name: 'deposits', role: 'deposits' as const, addresses: [...extra.depositAddresses], assets: [config.deposits.asset] }]
      : [],
    ...signerWallets.map(wallet => ({ name: `signer:${wallet.chain}`, role: 'signer' as const, addresses: [wallet.address!], assets: wallet.assets })),
  ];
};

/** An atomic amount of a pegged asset in micro-USD, rounded down (TR-6). */
export const atomicToUsd = (quantity: bigint, decimals: number): MicroUsd =>
  (decimals >= 6 ? quantity / 10n ** BigInt(decimals - 6) : quantity * 10n ** BigInt(6 - decimals)) as MicroUsd;

export interface ReconciliationEntry {
  // What the ledger says the chain holds: minus the treasury's balance, plus minus deposits clearing for the deposit asset
  readonly ledger: MicroUsd;
  readonly chain: MicroUsd;
  // chain - ledger
  readonly drift: MicroUsd;
  readonly alert: boolean;
}

// A drift above $1 alerts (TR-5): fees and rounding stay well below it
export const reconciliationThreshold = 1_000_000n as MicroUsd;

/**
 * Compares, per asset, what the ledger says the platform holds with what its wallets hold on chain
 * (TR-5). Money enters the ledger through the treasury and deposits clearing, so their balances are
 * minus what came in. The deposit asset also counts what sits on deposit addresses (DP-8).
 */
export const reconcile = ({ assets, ledgerBalances, chainBalances, depositAsset, threshold = reconciliationThreshold }: {
  readonly assets: readonly Asset[];
  // By ledger account ID: platform:treasury:<asset>, platform:deposits_clearing
  readonly ledgerBalances: ReadonlyMap<string, bigint>;
  // By asset name, in micro-USD
  readonly chainBalances: ReadonlyMap<string, MicroUsd>;
  readonly depositAsset: string | undefined;
  readonly threshold?: MicroUsd;
}): ReadonlyMap<string, ReconciliationEntry> => new Map(assets.map(asset => {
  const treasury = ledgerBalances.get(`platform:treasury:${asset.name}`) ?? 0n;
  const deposits = asset.name === depositAsset ? ledgerBalances.get('platform:deposits_clearing') ?? 0n : 0n;
  const ledger = (-treasury - deposits) as MicroUsd;
  const chain = chainBalances.get(asset.name) ?? 0n as MicroUsd;
  const drift = (chain - ledger) as MicroUsd;

  return [asset.name, { ledger, chain, drift, alert: drift > threshold || drift < -threshold }] as const;
}));
