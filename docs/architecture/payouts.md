# Payouts

Status: **draft**. Part of the [architecture overview](README.md).

Pays sellers their earnings once a month, in USDM on Cardano.

| | |
|---|---|
| Packages | `workers` (job, signing), `core`, `db`, `api` (approval) |
| Owns | `payout_runs`, `payouts` |
| Depends on | [Ledger](ledger.md), [Treasury](treasury.md), Blockfrost |
| [Build step](README.md#7-build-order) | 11 |

## Requirements

- **PO-1** Runs on the 1st of the month, UTC. For each payout address: earned minus paid out, after the platform fee. Pay it if it's at least the minimum ($10 by default). Smaller amounts roll over.
- **PO-2** Pays in USDM on Cardano, to the payout address in the service's active revision. USDM is the only payout asset in v1. The platform pays the network fee.
- **PO-3** Batches many payouts into one transaction. Splits into several at the transaction size limit. Batching keeps network fees low.
- **PO-4** Idempotent per payout address and period. A second run moves nothing.
- **PO-5** Before submitting, checks that the payout wallet covers the run. If not, stops and alerts.
- **PO-6** Moving funds on mainnet needs a human. On mainnet, a run builds its transactions and waits for an operator's approval through `POST /internal/v1/payouts/{run}/approve` ([AR10](README.md#8-open-questions)). Staging submits without approval.
- **PO-7** Books the payout in the ledger once the transaction is confirmed. A failed transaction leaves the earnings for the next run.
- **PO-8** Signs with the payout key from the stack's secrets, in Workers only.

## As built in step 11

- **The job** (`payouts`) runs every 10 minutes under its lock. It builds the run of the latest cutoff once (`run_<YYYY-MM-01>`), submits approved runs, and follows submitted ones.
- **Dues** come from `payments`: per service, net earnings (amount minus fee) of captured and settled payments last changed before the cutoff, minus `payout_items` of payouts not `failed`. They're grouped by seller and the active revision's payout address. Services paid in another asset are left out.
- **Transactions** batch 40 outputs each, built and signed with the Evolution SDK from `PAYOUT_WALLET_MNEMONIC` (the account's first address), and stored signed, with a validity window of 7 days. Each output gets its minimum ADA. Change returns to the wallet.
- **Approval (PO-6):** `environment: production` runs wait (`awaiting_approval`) for `POST /internal/v1/payouts/{run}/approve`, which is audited as `payout.approve`. A run past its window before approval is built again, and needs a new approval.
- **Coverage (PO-5):** the wallet's USDM is read before building. Short: the run is `stopped` with the reason, an alert is logged, and the next run tries again.
- **Booking (PO-7):** after 15 confirmations, each payout books seller earned → `platform:treasury:<asset>` once (`payout`, keyed by the payout ID). The chain refusing a transaction, or one unseen once its window passed, fails its payouts: their earnings are due in the next run.
- **Statuses:** a run is `awaiting_approval`, `approved`, `submitted`, `confirmed`, `failed`, `stopped`, or `empty`. Tables: `payout_runs`, `payout_transactions`, `payouts`, `payout_items`.
- `GET /v1/services/{id}/earnings` shows `paidOut` from confirmed payouts (LG-10).
