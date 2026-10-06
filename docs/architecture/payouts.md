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
