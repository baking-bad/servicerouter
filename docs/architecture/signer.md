# Signer

Status: **draft**. Part of the [architecture overview](README.md).

Holds the hot wallets the platform pays routed targets with.

| | |
|---|---|
| Package | `signer` (app) |
| Owns | `signatures`. Spend counters in its own Redis key prefix. |
| Depends on | [Common kit](common-kit.md), the official x402 client packages, the `mppx` client |
| [Build step](README.md#7-build-order) | 12 |

## Why a separate app

The proxy is public and runs many replicas, so it holds no key that moves funds. Payment routing must still pay targets while the buyer waits. A small internal service with its own spend limits keeps both: a compromised proxy can spend at most the Signer's limits.

## Requirements

- **SG-1** Holds one hot-wallet key per network we pay targets on: Base, Solana, Tempo. Keys come from the stack's secrets and live in `Secret`.
- **SG-2** Internal only: `POST /internal/v1/sign` with a shared-secret header. Input: request ID, quote ID, the chosen x402 option or MPP challenge, the resource URL, and the quoted target price. Output: the `PAYMENT-SIGNATURE` value, or the MPP `Authorization` value.
- **SG-3** Signs only when:
  - the network and asset are in the registry;
  - the amount is at most the quoted target price;
  - the amount is at most the per-call maximum in platform config ([AR8](README.md#8-open-questions));
  - the spend limits allow it.
- **SG-4** Spend limits per network, per rolling hour and day. Check and increment them atomically before signing. Over a limit → refuse and alert. The proxy returns `503 upstream_unavailable`, and the buyer isn't charged.
- **SG-5** The spend counters use a Redis ACL user that only the Signer has. The proxy can't reset them.
- **SG-6** Stopping the Signer stops all routed payments. The proxy answers `503`, uncharged. This is the kill switch.
- **SG-7** Records every signature: request ID, quote ID, network, asset, amount, `payTo`, time.
- **SG-8** Builds payloads with the official SDK client packages. Never hand-rolls EIP-3009 authorizations or chain transactions.
- **SG-9** Wallets stay small. Treasury tops them up ([TR-4](treasury.md)).

## As built in step 12

- **Dependencies (B-3):** the Signer reads platform config through `core` and writes `signatures` through `db`. It never imports `payments` or another app.
- **Wallets:** `SIGNER_BASE_KEY` (Base, `0x` and 64 hex). Solana and Tempo come later: Solana is off in production (P-6), and Tempo targets need the `mppx` client. Without a key, the Signer refuses every request for that chain.
- **The request:** `POST /internal/v1/sign` with `x-signer-secret` (`SIGNER_SECRET`, at least 32 characters) and `{ requestId, quoteId, x402Version, requirement, resource, url, quotedPrice }`, where `quotedPrice` is the quoted target price in micro-USD. The answer: `{ header, signatureId, network, asset, atomicAmount, amount, payTo }`. A refusal is `422 signing_refused` with its reason.
- **Checks, in order:** an `exact` option, a network and asset of the registry, a wallet on the chain, the amount at most the quote, then at most `signer.maxPerCall`, then the spend limits.
- **Spend limits:** one Lua script in Redis checks and adds both windows, `spend:<network>:hour:<UTC hour>` and `…:day:<UTC day>`. These are clock windows, not rolling ones. The hourly limit is optional (AR8). Readiness covers Postgres and Redis.
- **Metric:** `signer_spend_usd_total{network}`.
