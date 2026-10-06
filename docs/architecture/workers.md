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
| Ownership re-check | Each host daily: the job runs every 5 minutes and checks what is due | [Ownership verification](ownership-verification.md) | 8 |
| Deposit watcher | Every 20 seconds, a batch of due addresses | [Deposits](deposits.md) | 9 |
| Payouts | Every 10 minutes: builds once per cutoff, the 1st of the month, UTC | [Payouts](payouts.md) | 11 |
| Treasury balances | Every 5 minutes | [Treasury](treasury.md) | 11 |
| Reconciliation | Daily | [Treasury](treasury.md) | 11 |
| Catalog index | Every minute | [Catalog and intents](catalog-and-intents.md) | 13 |
| Service stats | Every 5 minutes | [Catalog and intents](catalog-and-intents.md) | 13 |

## Requirements

- **WK-1** One runner per job across replicas, through a Postgres advisory lock per job.
  - A session lock on a connection of its own (`Postgres.tryAdvisoryLock`). A run that finds it taken skips. A crashed holder's session ends, and the lock with it.
- **WK-2** Every job is idempotent and safe to rerun after a crash.
- **WK-3** Jobs read time from the `Clock` port. Tests drive them with a fake clock.
- **WK-4** Each job exports its last success time and duration. An alert fires when a job is stale.
  - `workers_job_last_success_timestamp_seconds{job}`, `workers_job_duration_seconds{job}`, and `workers_job_runs_total{job,result}` (`success`, `failure`, `skipped`). A failed run leaves the last success where it was.
  - A job runs one interval after the app starts, then one interval after each run ends, so its runs never overlap.
- **WK-5** Only the jobs that sign transactions load signing keys.
- **WK-7** The workers connect to Redis (`REDIS_URL`) to publish the invalidation events of service state changes (OV-5), and their readiness checks it.
- **WK-6** Settlement follow-up: for each `settling` payment, repeat the identical `settle` call ([PR-12](payment-rails.md)). Settled → book the earnings, and flag the payment for review if the buyer got no response. Definitively failed or expired → mark it `failed`. Nothing is booked.
  - MPP payments ([PR-9](payment-rails.md)) have no settle to repeat. The job reads the transaction's receipt by its hash on the Tempo RPC. Succeeded with the expected transfer → book it, flagged for review if no receipt went out. Reverted → `failed`. Not found once the transaction's validity window has passed → `failed`. Otherwise → next run. The job never broadcasts.
  - It repeats the stored `settlement_request` through the network's facilitator. Still pending → next run.
  - A facilitator that doesn't answer, or a payment with nothing to repeat, fails the run after trying the rest, so the job goes stale and its alert fires.
