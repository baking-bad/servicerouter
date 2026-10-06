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
- **DP-2** The watcher reads transactions to buyer addresses through Blockfrost. Polling is fine at MVP scale.
- **DP-3** Credit a deposit exactly once, after the confirmation threshold, keyed by transaction hash and output index: deposits clearing → buyer available.
- **DP-4** Credit USDM 1:1 in USD. Record other assets, ADA included, and don't credit them. ADA needs a price feed first.
- **DP-5** `GET /v1/topup/{token}` returns the address, the asset and network, and the status of recent deposits.
- **DP-6** Credits are a USD balance. They don't expire. Buyers can't withdraw them in v1.
- **DP-7** Staging uses `cardano:preprod` and test USDM.
- **DP-8** Sweeping deposits into the treasury comes later. Until then, funds stay on buyer addresses, and Treasury counts them there.
