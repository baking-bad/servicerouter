# Treasury

Status: **draft**. Part of the [architecture overview](README.md).

The platform's own wallets: what we hold, where, and whether it matches the ledger. Buyers pay in many assets and sellers get USDM on Cardano, so the platform holds several assets between payment and payout. In v1, conversion between them is manual.

| | |
|---|---|
| Packages | `workers`, `core`, `db`, `api` (internal) |
| Owns | `treasury_transfers`, `reconciliation_runs`. The wallet list in platform config. |
| Depends on | [Ledger](ledger.md), [Platform config](platform-config.md), chain APIs |
| [Build step](README.md#7-build-order) | 11. Signer wallets in step 12. |

## Requirements

- **TR-1** Platform config lists every platform wallet: x402 `payTo` addresses (Base, Solana, Cardano), the MPP recipient (Tempo), the Signer's hot wallets, the payout wallet, and the deposit HD wallet.
- **TR-2** Receiving addresses (`payTo`, the MPP recipient) need no online key. Keep their keys offline.
- **TR-3** Balance monitor: each wallet and asset as a metric. Alert when a Signer wallet runs low, or when the payout wallet won't cover the next run.
- **TR-4** Rebalancing is manual in v1. Operators bridge or swap, then record the transfer with its transaction references through `POST /internal/v1/treasury/transfers`. The ledger books it as a treasury transfer.
- **TR-5** Daily reconciliation compares ledger treasury balances with on-chain balances. It alerts on drift above a threshold.
- **TR-6** Earnings are fixed in USD at payment time. The platform absorbs peg moves and conversion costs.
- **TR-7** Keep hot wallets at minimal balances.
