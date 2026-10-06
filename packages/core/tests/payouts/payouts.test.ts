import { fixtureRun, fixtureTime } from '@servicerouter/testing';

import { describe, expect, it } from 'vitest';

import type { MicroUsd } from '@servicerouter/common';

import {
  atomicToUsd, batchPayouts, findAsset, payoutCutoff, payoutRunId, planPayouts, reconcile, treasuryWallets, usdToAtomic,
} from '../../src/index.js';
import { examplePlatform } from '../fixtures.js';

const usd = (value: number): MicroUsd => BigInt(Math.round(value * 1_000_000)) as MicroUsd;

describe('planning payouts (PO-1, PO-3, PO-4)', () => {
  it('runs at the 1st of the month, UTC, with one run ID per cutoff', () => {
    expect(payoutCutoff(new Date(fixtureTime(1, 1, 0, 0, 0, 0)))).toEqual(new Date(fixtureTime(1, 1, 0, 0, 0, 0)));
    expect(payoutCutoff(new Date(fixtureTime(1, 30, 23, 59, 59, 999)))).toEqual(new Date(fixtureTime(1, 1, 0, 0, 0, 0)));
    expect(payoutRunId(new Date(fixtureTime(1, 1, 0, 0, 0, 0)))).toBe(fixtureRun(1, 1));
  });

  it('pays each seller and address the sum of its services\' dues, if at least the minimum; the rest rolls over', () => {
    const planned = planPayouts([
      { serviceId: 'b', sellerAccountId: 'acc_1', address: 'addr1', amount: usd(6) },
      { serviceId: 'a', sellerAccountId: 'acc_1', address: 'addr1', amount: usd(5) },
      { serviceId: 'c', sellerAccountId: 'acc_1', address: 'addr2', amount: usd(9.99) },
      { serviceId: 'd', sellerAccountId: 'acc_2', address: 'addr1', amount: usd(10) },
      { serviceId: 'e', sellerAccountId: 'acc_3', address: 'addr3', amount: usd(-1) },
    ], usd(10));

    expect(planned).toEqual([
      { sellerAccountId: 'acc_1', address: 'addr1', amount: usd(11), items: [{ serviceId: 'a', amount: usd(5) }, { serviceId: 'b', amount: usd(6) }] },
      { sellerAccountId: 'acc_2', address: 'addr1', amount: usd(10), items: [{ serviceId: 'd', amount: usd(10) }] },
    ]);
  });

  it('batches outputs into transactions, and converts USD 1:1 to the asset\'s units', () => {
    expect(batchPayouts([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(usdToAtomic(usd(1.5), 6)).toBe(1_500_000n);
    expect(usdToAtomic(usd(1.5), 18)).toBe(1_500_000_000_000_000_000n);
    expect(atomicToUsd(1_500_000_000_000_000_000n, 18)).toBe(usd(1.5));
  });
});

describe('the treasury (TR-1, TR-5)', () => {
  it('lists each payTo wallet with its assets, the payout wallet, and the deposit addresses', () => {
    const wallets = treasuryWallets(examplePlatform, { payoutAddress: 'addr_test1payout', depositAddresses: ['addr_test1a', 'addr_test1b'] });

    expect(wallets.map(wallet => [wallet.role, wallet.assets.map(asset => asset.name)])).toEqual(expect.arrayContaining([
      ['pay_to', ['base-usdc']],
      ['payout', ['cardano-usdm']],
      ['deposits', ['cardano-usdm']],
    ]));
    expect(wallets.find(wallet => wallet.role === 'deposits')?.addresses).toEqual(['addr_test1a', 'addr_test1b']);
  });

  it('compares the ledger\'s holdings with the chain\'s per asset, deposits included, and alerts above $1 of drift', () => {
    const usdm = findAsset(examplePlatform, 'cardano-usdm')!;
    const base = findAsset(examplePlatform, 'base-usdc')!;
    const results = reconcile({
      assets: [usdm, base],
      // 100 settled in USDM, 50 deposited, 30 paid out; 20 settled in USDC
      ledgerBalances: new Map([
        ['platform:treasury:cardano-usdm', -70_000_000n], ['platform:deposits_clearing', -50_000_000n], ['platform:treasury:base-usdc', -20_000_000n],
      ]),
      chainBalances: new Map([['cardano-usdm', usd(120)], ['base-usdc', usd(18)]]),
      depositAsset: 'cardano-usdm',
    });

    expect(results.get('cardano-usdm')).toEqual({ ledger: usd(120), chain: usd(120), drift: 0n, alert: false });
    expect(results.get('base-usdc')).toEqual({ ledger: usd(20), chain: usd(18), drift: usd(-2), alert: true });
  });
});
