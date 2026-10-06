# Ledger

Status: **draft**. Part of the [architecture overview](README.md).

Balances, earnings, and the record of every paid call.

| | |
|---|---|
| Packages | `core` (rules: payment statuses and their changes, the fee split, the UTC day), `db` (schema, the operations, repositories). The rails' ports onto it (`CreditsLedger`, `PaymentRecorder`) are in `payments`. |
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

Ledger account IDs are readable: `<account ID>:available`, `<account ID>:held`, `<account ID>:earned`, `platform:fees`, `platform:deposits_clearing`. Each is created on first use, with a `balances` row. Until deposits exist (step 9), an operator's admin credit through the internal API is the deposit: deposits clearing → buyer available.

## Requirements

- **LG-1** Amounts are integer micro-USD as `bigint` ([CK-4](common-kit.md)).
- **LG-2** Double-entry: every movement is one ledger transaction whose entries sum to zero, written in one database transaction. A balances table is updated in the same transaction, with `CHECK` constraints so balances never go negative.
  - The one exception is deposits clearing: money enters through it, so its balance is minus everything deposited (`balances.may_go_negative`).
  - One lock order everywhere, so concurrent operations never deadlock: the members' balances by ledger account ID, then the entries, then the platform's balances, then the key's daily spend, then its total spend. The payment row is written and its status changed before the balances. The platform's fee row, which every capture shares, is held only until the commit.
- **LG-3** Idempotency: each operation is keyed by its payment or job ID, with a unique constraint. A retry never moves money twice.
  - The key is `(operation, reference)` on `ledger_transactions`. Hold, capture, and release use the payment ID. A repeated hold returns the first one, and a repeated capture or release moves nothing.
  - An admin credit uses the operator's `reference`. The same reference, account, and amount again moves nothing and answers with the first credit. The same reference with another account or amount is `409 idempotency_conflict`.
- **LG-4** The fee is split at capture or settlement: `amount × feeBps / 10000`, rounded down to the micro-USD ([AR6](README.md#8-open-questions)). The seller gets the rest. The buyer sees one price. A routed call's fee is already in its quote.
- **LG-5** Earnings are fixed in USD at payment time. The platform covers conversion costs and price moves.
- **LG-6** A hold updates the balance, the key's daily spend, and the key's total spend in one database transaction. A release gives back all three. N parallel holds never overdraw the balance, pass the daily budget, or pass the allowance ([AK-7](accounts-and-keys.md)).
  - The hold writes the `payments` row as `held` in the same transaction. A refused hold leaves nothing: no movement, no spend, no row.
  - A refusal is `insufficient_balance`, `key_budget_exceeded`, or `key_allowance_exceeded`. Revocation, expiry, and the maximum price are the credits rail's checks, before the hold.
  - The daily spend is kept per UTC day. A release gives it back to the day the hold counted it on.
- **LG-7** A `payments` row has: request ID, kind (`service` or `routed`), buyer if known, service and route or target host and path, rail, network, asset, USD and atomic amounts, fee, billing decision, status, external references (transaction hash, receipt), upstream latency, a review flag, and timestamps.
- **LG-8** Statuses: `held`, `verified`, `captured`, `settling`, `settled`, `released`, `cancelled`, `failed`. The repository allows only valid changes. The `payments` table is the source of truth for seller earnings on every rail.
- **LG-9** Hold expiry: a worker finishes holds older than a TTL, which is longer than the proxy's total timeout. It follows the recorded decision: capture if billable, release otherwise or when there is no decision.
  - The TTL is the larger of 5 minutes and twice the proxy's total timeout. Its capture takes `feeBps` from platform config at that moment.
  - It pages oldest first. A run that couldn't finish a hold fails after trying all of them, so the job goes stale and its alert fires.
- **LG-10** Earnings view, per service and per seller: calls, USD earned by rail, fee, paid out, pending, and the next payout date. Served at `GET /v1/services/{id}/earnings`.
  - Built so far: the per-service view, for the service's owner. Earnings count captured and settled payments. Pending is earned minus paid out, and the next payout date is the 1st of next month, UTC. The per-seller view isn't served yet.
- **LG-11** Holds and captures go to Postgres: two writes per call. Move holds to Redis, with an asynchronous ledger, only if the step 4 load test misses 50 ms p95.
