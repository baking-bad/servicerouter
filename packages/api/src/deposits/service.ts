import { formatUsd, type Clock, type IdGenerator, type Logger } from '@servicerouter/common';
import {
  cryptoRandomSource, type DepositAddressDeriver, type DepositRecord, type PlatformConfig, type RandomSource,
} from '@servicerouter/core';
import { createDepositRepository, type Database, type DepositAddressView } from '@servicerouter/db';

import { NotFoundError } from '../errors.js';

export interface DepositServiceOptions {
  readonly db: Database;
  readonly config: PlatformConfig;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  // Derives deposit addresses from the account public key (DP-1). Without it, deposits are off here.
  readonly deriver: DepositAddressDeriver | undefined;
  // Randomness for top-up tokens. Default: node:crypto.
  readonly random?: RandomSource;
}

/** The account's deposit address and top-up link (AK-1, AK-15). */
export interface AccountDeposit {
  readonly address: string;
  readonly network: string;
  readonly asset: string;
  readonly topupUrl: string;
}

/** `GET /v1/topup/{token}` (DP-5): where to send funds, and what arrived. */
export interface TopupView {
  readonly address: string;
  readonly asset: { readonly name: string; readonly symbol: string; readonly network: string; readonly networkTitle: string };
  readonly confirmationsRequired: number;
  readonly deposits: readonly {
    readonly transactionHash: string;
    readonly outputIndex: number;
    // The USD it credits, or null for an output without the deposit asset
    readonly amount: string | null;
    readonly status: 'confirming' | 'credited' | 'not_credited' | 'dropped';
    readonly confirmations: number;
    readonly confirmationsRequired: number;
    readonly seenAt: string;
    readonly creditedAt: string | null;
  }[];
}

export interface DepositService {
  /** The account's deposit address, created the first time (DP-1). Undefined while deposits are off. */
  ensure(accountId: string): Promise<AccountDeposit | undefined>;
  /** The top-up data by its token (DP-5). Opening it moves the address's next scan up. */
  topup(token: string): Promise<TopupView>;
}

// The top-up token: 24 random bytes, base64url (AK-15)
const topupTokenBytes = 24;
const topupTokenPattern = /^[A-Za-z0-9_-]{32}$/;
// The latest deposits on the page
const recentDeposits = 20;

// The registry has no symbol: an asset's name ends with it, as `cardano-usdm` does
const symbolOf = (name: string): string => (name.split('-').at(-1) ?? name).toUpperCase();

export const createDepositService = ({
  db, config, clock, ids, logger, deriver, random = cryptoRandomSource,
}: DepositServiceOptions): DepositService => {
  const deposits = createDepositRepository({ db, clock, ids });
  const settings = config.deposits;
  const topupUrl = (token: string): string => `${config.urls.website}/topup/${token}`;
  const view = (address: DepositAddressView): AccountDeposit => ({
    address: address.address, network: address.network, asset: settings!.asset.name, topupUrl: topupUrl(address.topupToken),
  });

  const toDeposit = (deposit: DepositRecord, tipHeight: number | undefined): TopupView['deposits'][number] => {
    const required = settings!.confirmations;
    const confirmations = deposit.status === 'credited'
      ? required
      : Math.max(0, Math.min(required, (tipHeight ?? deposit.blockHeight) - deposit.blockHeight + 1));

    return {
      transactionHash: deposit.txHash,
      outputIndex: deposit.outputIndex,
      amount: deposit.usdAmount === undefined ? null : formatUsd(deposit.usdAmount),
      status: deposit.status === 'pending' ? 'confirming' : deposit.status,
      confirmations,
      confirmationsRequired: required,
      seenAt: deposit.seenAt.toISOString(),
      creditedAt: deposit.creditedAt?.toISOString() ?? null,
    };
  };

  return {
    ensure: async accountId => {
      if (!settings || !deriver)
        return undefined;

      const address = await deposits.ensureAddress({
        accountId,
        network: settings.network.id,
        derive: deriver,
        token: () => Buffer.from(random.bytes(topupTokenBytes)).toString('base64url'),
      });
      if (address.network !== settings.network.id)
        logger.error({ accountId, network: address.network }, 'A deposit address belongs to another network than the deposits config');

      return view(address);
    },

    topup: async token => {
      const address = settings && topupTokenPattern.test(token) ? await deposits.findAddressByToken(token) : undefined;
      if (!settings || !address)
        throw new NotFoundError('No such top-up link');

      // Someone is about to pay: scan this address on the next run (DP-2)
      await deposits.prioritize(address.address, clock.now());
      const recent = await deposits.recent(address.accountId, recentDeposits);

      return {
        address: address.address,
        asset: { name: settings.asset.name, symbol: symbolOf(settings.asset.name), network: settings.network.id, networkTitle: settings.network.title },
        confirmationsRequired: settings.confirmations,
        deposits: recent.map(deposit => toDeposit(deposit, address.tipHeight)),
      };
    },
  };
};
