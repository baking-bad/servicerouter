# Deposits

Status: **draft**. Part of the [architecture overview](README.md).

Turns USDM sent to a buyer's Cardano deposit address into credits.

| | |
|---|---|
| Packages | `core`, `db`, `workers` (watcher), `api` (top-up data) |
| Owns | `deposit_addresses`, `deposits` |
| Depends on | [Ledger](ledger.md), Blockfrost |
| [Build step](README.md#7-build-order) | 9 |

Each buyer gets their own Cardano deposit address on the platform. Whatever they deposit shows up as credits. The top-up link is a page with that address. Later, an on-ramp partner lets users pay by card or Apple Pay into the same address.

## Requirements

- **DP-1** One Cardano address per account, created at signup ([AK-1](accounts-and-keys.md)) and derived from one HD wallet at the account's index. A shared address couldn't tell which account sent a deposit. Derive addresses from the account public key. The Platform API and the watcher never hold the private key.
  - As built in step 9: the enterprise address of `m/1852'/1815'/0'/0/<index>` (CIP-1852, soft derivation). The API reads the account public key of `m/1852'/1815'/0'` from `DEPOSIT_ACCOUNT_PUBLIC_KEY`, 128 hex characters, and refuses to start without a usable one while deposits are on. `scripts/deposit-keygen.mjs` makes the wallet.
  - Indices come from a Postgres sequence. An account created before step 9 gets its address on its next `GET /v1/account`.
- **DP-2** The watcher reads transactions to buyer addresses through Blockfrost. Polling is fine at MVP scale.
  - The job runs every 20 s and scans at most 10 due addresses, the longest-waiting first, one at a time. An address is due again 1 minute after a scan that left a deposit confirming, 10 minutes otherwise. Opening the top-up page makes it due at once.
  - Each scan reads the address's transactions from the last scanned block on, and the outputs of each new transaction. A failed address fails the run, so the job goes stale (WK-4).
- **DP-3** Credit a deposit exactly once, after the confirmation threshold, keyed by transaction hash and output index: deposits clearing → buyer available.
  - The threshold is `deposits.confirmations` blocks, the deposit's own included: 15 by default, about 5 minutes. Before crediting, the watcher reads the transaction again. A re-org that dropped it makes it `dropped`; one that moved it resets its count.
  - The ledger reference is `deposit:<transaction hash>:<output index>`. A deposit is `pending`, `credited`, `not_credited` (no deposit asset in it), or `dropped`.
- **DP-4** Credit USDM 1:1 in USD. Record other assets, ADA included, and don't credit them. ADA needs a price feed first.
- **DP-5** `GET /v1/topup/{token}` returns the address, the asset and network, and the status of recent deposits.
  - `{ address, asset: { name, symbol, network, networkTitle }, confirmationsRequired, deposits: [{ transactionHash, outputIndex, amount, status, confirmations, confirmationsRequired, seenAt, creditedAt }] }`, the latest 20, newest first. `status` is `confirming`, `credited`, `not_credited`, or `dropped`. Confirmations come from the chain's tip at the last scan.
  - No key. Limited per client IP (`rateLimits.topup`, 60 a minute by default). An unknown token is `404 not_found`. `Cache-Control: no-store`.
- **DP-6** Credits are a USD balance. They don't expire. Buyers can't withdraw them in v1.
- **DP-7** Staging uses `cardano:preprod` and test USDM. The MVP takes real USDM on `cardano:mainnet`; tests use the fake Blockfrost.
- **DP-8** Sweeping deposits into the treasury comes later. Until then, funds stay on buyer addresses, and Treasury counts them there.
