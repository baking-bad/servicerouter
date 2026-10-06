# Cardano facilitator

Status: **draft**. Part of the [architecture overview](README.md).

Verifies and settles x402 payments on Cardano. We don't build it. We run the Cardano Foundation's open-source facilitator as a service in our Docker Compose stack.

| | |
|---|---|
| Image | `cardanofoundation/cardano-x402-facilitator`, pinned to a tag. `1.0.0-pre1` is the latest at the time of writing. `linux/amd64` only. |
| Runtime | Java 21, Spring Boot. Port `4022`. |
| Owns | Its own Postgres 17 database. The app creates its `facilitator` schema on start. |
| Used by | [Payment rails](payment-rails.md) (the x402 rail) |
| Chain access | Hosted Blockfrost |
| [Build step](README.md#7-build-order) | 6 |

## What the image does

- Implements x402 v2, scheme `exact` on Cardano. Transfer methods: `default` (address to address), `masumi` (escrow), and `script` (Plutus locks). We use `default` only.
- Holds no keys and signs nothing. It checks the transaction the buyer already signed (signatures, recipient, asset, amount, validity window, fees, value conservation) and submits it. The buyer pays the network fee.
- Journals every settlement in Postgres. Retrying the same payload never broadcasts twice. Several instances can share one database. They coordinate with advisory locks.
- Has no HTTP authentication and no rate limiting.

| Endpoint | Purpose |
|---|---|
| `POST /verify` | Checks a signed payment. |
| `POST /settle` | Submits it and waits for confirmation. |
| `GET /supported` | Lists `(x402Version, scheme, network)` with `extra`: transfer methods, `areFeesSponsored`, `l1Confirmations` range. |
| `GET /health` | Human-readable summary. |
| `GET /actuator/health` | Health probe. |
| `GET /actuator/prometheus` | Metrics. |

## Services in our stack

| Service | Image | Networks | Notes |
|---|---|---|---|
| `cardano-facilitator` | `cardanofoundation/cardano-x402-facilitator:<pinned tag>` | Internal only | No Traefik labels, no published port. Placed on an `amd64` node. |
| `cardano-facilitator-db` | `postgres:17-alpine` | Internal only | Its own volume. Backed up with our other databases. |

This is the image's "light" deployment profile: Postgres plus the facilitator, with hosted Blockfrost. Its "full" and "yano" profiles run a Cardano node and an indexer instead of Blockfrost. We don't need them in v1.

## Settings

| Setting | Value | Why |
|---|---|---|
| `BLOCKFROST_PROJECT_ID` | From the stack's secrets | Chain access. |
| `BLOCKFROST_BASE_URL` | Hosted Blockfrost for the network | Default for the selected network. |
| `CARDANO_NETWORK` | `mainnet` (the MVP has no staging). `preprod` in a staging stack | Network selection. |
| `POSTGRES_ADMIN_PASSWORD` | From the stack's secrets | The image's default, `postgres`, is for development only. |
| `x402.networks[].id` | `cardano:preprod` or `cardano:mainnet` | One entry per network. |
| `x402.settle.accept-mempool` | `false` | Mempool presence is not payment. Always `false`. |
| `x402.settle.confirmation-timeout` | `10s` | How long `/settle` waits for confirmation. The default, `75s`, is past the proxy's settle timeout (`timeouts.settleMs`, 30 s), and the SDK repeats a pending answer once. At 10 s, a slow block answers `settlement_pending`, the response goes out, and the workers finish the settlement ([PR-12](payment-rails.md)). Measure on preprod. |
| `x402.settle.poll-interval` | `5s` (default) | |
| `x402.settle.stability-window` | `10m` (default) | Watches for rollbacks after confirmation. |
| `x402.chain.max-tip-age` | `5m` (default) | A stale chain backend fails closed. Nothing is submitted. |
| `x402.http.max-request-bytes` | `65536` (default) | Larger requests get `413`. |
| `x402.http.cors-allowed-origins` | Empty (default) | Only our proxy calls it. |

Networks in `application.yml` form:

```yaml
x402:
  networks:
    - id: "cardano:preprod"
      chain:
        blockfrost:
          base-url: https://cardano-preprod.blockfrost.io/api/v0
          project-id: ${BLOCKFROST_PROJECT_ID}
```

`NETWORKS_FILE=file:/path/to/networks.yml` replaces this list. The `file:` prefix is required. A bare path is silently ignored.

## Requirements

- **CF-1** Run the image as the two services above. Pin the image tag. Upgrade it on purpose, never by pulling `latest`.
- **CF-2** Keep it on the internal network. The image has no authentication and no rate limiting, so only the proxy may reach it. If it ever needs to be reached from outside that network, put an authenticated, rate-limited TLS ingress in front of it first.
- **CF-3** Staging runs `cardano:preprod`. Production runs `cardano:mainnet` only after [CF-8](#requirements) passes. The MVP runs mainnet only: CF-8's checks are step 6's live check ([AR18](README.md#8-open-questions)).
- **CF-4** Keep `x402.settle.accept-mempool=false` in every deployment.
- **CF-5** The confirmation policy comes from us, not from the facilitator's config. The x402 rail puts `extra.confirmationPolicy.l1Confirmations` in our Cardano `accepts` entry ([AR12](README.md#8-open-questions)). `0` means block inclusion. `1..20` means that many blocks on top. `-1` is an operator opt-in for accepting before inclusion. We don't use it. Cardano makes a block about every 20 seconds, so settlement takes tens of seconds.
- **CF-6** The x402 rail handles every answer shape ([PR-12](payment-rails.md)):
  - `/verify` and `/settle` answer `200` even when they reject. Read `isValid` or `success`, not the status code.
  - `/verify` rejects with `isValid: false`, an `invalidReason`, and an `invalidMessage`.
  - `/settle` confirmed: `success: true`, `transaction`, `extra.status: confirmed`, `extra.confirmations`.
  - `/settle` pending: `success: false`, `errorReason: settlement_pending`, a non-empty `transaction`, `extra.status: pending`. The transaction was broadcast. This is not a failure. Retry the identical payload later.
  - `/settle` failed: `success: false`, `errorReason` such as `exact_cardano_settlement_failed` or `exact_cardano_settlement_definitively_rejected`. `transaction: ""` means nothing was submitted.
  - `/settle` expired: `exact_cardano_settlement_failed` with `extra.status: expired`. The claim stays reserved: final, never resubmitted.
  - `/settle` `duplicate_settlement`: the same payment was already claimed. Final: nothing new moved.
  - `503`: the chain backend is unhealthy, with `errorReason: exact_cardano_facilitator_chain_lookup_failed`. Treat the outcome as unknown, as for a timeout. The facilitator's journal makes the repeat safe.
  - An expired transaction is never resubmitted.
- **CF-7** Keep the versions compatible. The image targets `@x402/cardano` 2.26.0. Pin our `@x402/cardano` to a version the pinned image supports. Upgrade both together, and run the staging check from build step 6 after every upgrade.
- **CF-8** Before mainnet, all of these hold:
  - the network entry is `cardano:mainnet`;
  - the database password is production-grade, and the facilitator connects with a least-privilege role;
  - the Blockfrost key comes from the stack's secrets;
  - `x402.settle.accept-mempool=false`;
  - our quotes set `l1Confirmations`;
  - a small live mainnet payment settles end to end through our proxy;
  - the product owner approves ([AR18](README.md#8-open-questions)).

  The image's authors haven't run it on mainnet yet. This check is ours to do.
- **CF-9** Health and metrics: a Docker health check on `/actuator/health`. Prometheus scrapes `/actuator/prometheus`, with the `prometheus-job` and `prometheus-port` labels. The proxy's readiness includes the facilitator's `GET /supported` ([PR-6](payment-rails.md)).
- **CF-10** One replica is enough for v1. Scaling out means more instances on the same database.
- **CF-11** Tests: functional tests use the fake x402 facilitator from `packages/testing`, scripted with every answer shape in CF-6. The real image is exercised on `cardano:mainnet` in step 6's live check, with a small real payment.
