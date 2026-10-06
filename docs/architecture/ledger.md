# Ledger

Status: **draft**. Part of the [architecture overview](README.md).

Balances, earnings, and the record of every paid call.

| | |
|---|---|
| Packages | `core` (operations), `db` (schema, repositories) |
| Owns | `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `balances`, `payments`, `key_daily_spend`, `key_total_spend` |
| Depends on | [Common kit](common-kit.md) (money) |
| [Build step](README.md#7-build-order) | 4, extended in steps 5–12 |

## Accounts and operations

| Owner | Accounts |
|---|---|
| Account, as a buyer | available, held |
| Account, as a seller | earned, paid out |
| Platform | fees, routing fees, routing losses, deposits clearing, treasury per asset |

| Operation | Movement |
|---|---|
| Deposit | Deposits clearing → buyer available |
| Hold | Buyer available → buyer held. Fails if funds are short. |
| Capture | Buyer held → seller earned + platform fees |
| Release | Buyer held → buyer available |
| x402 or MPP settled | Treasury of the asset → seller earned + platform fees |
| Payout | Seller earned → seller paid out, against the treasury |
| Routed call | Buyer held, or the treasury of the buyer's asset → the treasury of the target's asset + routing fees |
| Routing loss | Routing losses → the treasury of the target's asset. The target kept our payment and the buyer wasn't charged. |
| Treasury transfer | The treasury of one asset → the treasury of another. Rebalancing, recorded by an operator. |

## Requirements

- **LG-1** Amounts are integer micro-USD as `bigint` ([CK-4](common-kit.md)).
- **LG-2** Double-entry: every movement is one ledger transaction whose entries sum to zero, written in one database transaction. A balances table is updated in the same transaction, with `CHECK` constraints so balances never go negative.
- **LG-3** Idempotency: each operation is keyed by its payment or job ID, with a unique constraint. A retry never moves money twice.
- **LG-4** The fee is split at capture or settlement: `amount × feeBps / 10000`, rounded down to the micro-USD ([AR6](README.md#8-open-questions)). The seller gets the rest. The buyer sees one price. A routed call's fee is already in its quote.
- **LG-5** Earnings are fixed in USD at payment time. The platform covers conversion costs and price moves.
- **LG-6** A hold updates the balance, the key's daily spend, and the key's total spend in one database transaction. A release gives back all three. N parallel holds never overdraw the balance, pass the daily budget, or pass the allowance ([AK-7](accounts-and-keys.md)).
- **LG-7** A `payments` row has: request ID, kind (`service` or `routed`), buyer if known, service and route or target host and path, rail, network, asset, USD and atomic amounts, fee, billing decision, status, external references (transaction hash, receipt), upstream latency, a review flag, and timestamps.
- **LG-8** Statuses: `held`, `verified`, `captured`, `settling`, `settled`, `released`, `cancelled`, `failed`. The repository allows only valid changes. The `payments` table is the source of truth for seller earnings on every rail.
- **LG-9** Hold expiry: a worker finishes holds older than a TTL, which is longer than the proxy's total timeout. It follows the recorded decision: capture if billable, release otherwise or when there is no decision.
- **LG-10** Earnings view, per service and per seller: calls, USD earned by rail, fee, paid out, pending, and the next payout date. Served at `GET /v1/services/{id}/earnings`.
- **LG-11** Holds and captures go to Postgres: two writes per call. Move holds to Redis, with an asynchronous ledger, only if the step 4 load test misses 50 ms p95.
