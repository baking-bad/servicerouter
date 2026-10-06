# Workers

Status: **draft**. Part of the [architecture overview](README.md).

Runs every background job.

| | |
|---|---|
| Package | `workers` |
| Owns | No tables of its own. Each job writes through its component. |
| [Build step](README.md#7-build-order) | 4 (hold expiry), then grows |

## Jobs

| Job | Schedule | Component | Step |
|---|---|---|---|
| Hold expiry | Every minute | [Ledger](ledger.md) | 4 |
| Settlement follow-up | Every 30 seconds | [Payment rails](payment-rails.md) | 5 |
| Ownership re-check | Daily, spread over the day | [Ownership verification](ownership-verification.md) | 8 |
| Deposit watcher | Every few seconds | [Deposits](deposits.md) | 9 |
| Payouts | The 1st of the month, UTC | [Payouts](payouts.md) | 11 |
| Treasury balances | Every few minutes | [Treasury](treasury.md) | 11 |
| Reconciliation | Daily | [Treasury](treasury.md) | 11 |
| Service stats | Every few minutes | [Catalog and intents](catalog-and-intents.md) | 13 |

## Requirements

- **WK-1** One runner per job across replicas, through a Postgres advisory lock per job.
- **WK-2** Every job is idempotent and safe to rerun after a crash.
- **WK-3** Jobs read time from the `Clock` port. Tests drive them with a fake clock.
- **WK-4** Each job exports its last success time and duration. An alert fires when a job is stale.
- **WK-5** Only the jobs that sign transactions load signing keys.
- **WK-6** Settlement follow-up: for each `settling` payment, repeat the identical `settle` call ([PR-12](payment-rails.md)). Settled → book the earnings, and flag the payment for review if the buyer got no response. Definitively failed or expired → mark it `failed`. Nothing is booked.
