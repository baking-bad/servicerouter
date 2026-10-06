# Platform API

Status: **draft**. Part of the [architecture overview](README.md).

The public HTTP surface of the control plane, plus a private internal API.

| | |
|---|---|
| Package | `api` |
| Hosts | `api.servicerouter.ai` (public), an internal port (private) |
| Owns | No tables of its own. Each endpoint belongs to a component. |
| [Build step](README.md#7-build-order) | 2, then grows with each step |

## Public endpoints

| Endpoint | Component | Step |
|---|---|---|
| `POST /v1/accounts` | [Accounts and keys](accounts-and-keys.md) | 2 |
| `GET /v1/account`, `POST /v1/account/master-key/rotate` | [Accounts and keys](accounts-and-keys.md) | 2 |
| `PUT /v1/services/{id}`, `GET /v1/services/{id}`, `GET …/revisions`, `POST …/rollback` | [Service registry](service-registry.md) | 2 |
| `PUT /v1/services/{id}/secrets/{name}` | [Secrets](secrets.md) | 2 |
| `POST /v1/keys`, `GET /v1/keys`, `PATCH /v1/keys/{id}`, `DELETE /v1/keys/{id}` | [Accounts and keys](accounts-and-keys.md) | 4 |
| `GET /v1/balance`, `GET /v1/payments` | [Ledger](ledger.md) | 4 |
| `GET /v1/services/{id}/earnings` | [Ledger](ledger.md) | 4 |
| `GET /v1/services/{id}/status`, `POST …/verify` | [Ownership verification](ownership-verification.md) | 8 |
| `PUT /v1/account/email`, `POST /v1/account/email/confirm` | [Accounts and keys](accounts-and-keys.md) | 9 |
| `POST /v1/account/recover`, `POST /v1/account/recover/confirm` | [Accounts and keys](accounts-and-keys.md) | 9 |
| `GET /v1/topup/{token}` | [Deposits](deposits.md) | 9 |
| `GET /v1/services/{id}/openapi.json`, `…/llms.txt`, `…/skill.md` | [Agent docs](agent-docs.md) | 10 |
| `GET /v1/catalog`, `GET /v1/catalog/{id}` | [Catalog and intents](catalog-and-intents.md) | 13 |
| `POST /v1/intents` | [Catalog and intents](catalog-and-intents.md) | 13 |
| `POST /v1/assistant/drafts` | [Config assistant](config-assistant.md) | 14 |

## Internal endpoints

| Endpoint | Component | Step |
|---|---|---|
| `POST /internal/v1/accounts/{id}/credits` | [Ledger](ledger.md): admin top-up until deposits exist | 4 |
| `POST /internal/v1/hosts/{host}/verify` | [Ownership verification](ownership-verification.md), staging only | 8 |
| `POST /internal/v1/treasury/transfers` | [Treasury](treasury.md) | 11 |
| `POST /internal/v1/payouts/{run}/approve` | [Payouts](payouts.md) | 11 |
| `PUT /internal/v1/routed-endpoints` | [Payment routing](payment-routing.md) | 12 |
| `PUT /internal/v1/routed-endpoints/{host}/fee` | [Payment routing](payment-routing.md): per-endpoint `fee_bps` | 12 |
| `PUT /internal/v1/blocklist/{host}` | [Payment routing](payment-routing.md) | 12 |

## Requirements

- **PA-1** REST with JSON bodies, under `/v1/`. Service configs are accepted as YAML or JSON. Config delivery works like `kubectl apply`: `PUT` the whole config, with its secrets in the same request if needed ([SR-12](service-registry.md)).
- **PA-2** Auth: the master key for every account endpoint: the account, keys, services, secrets, balance, payments, and earnings. Payment keys work only on the proxy. Here they get `401 wrong_key_type` ([AK-4](accounts-and-keys.md)). Signup, email confirmation, recovery, the top-up data, catalog, intents, and agent docs need no key.
- **PA-3** Errors: `{ "error": { "code": "...", "message": "..." } }`. Config errors add `details` with the path, line, and column.
- **PA-4** The internal listener binds to the internal network only. Traefik never routes to it. It requires a shared-secret header, compared with `Secret.equals`. Every internal call writes the audit log.
- **PA-5** Endpoints that need no key are rate limited per IP. Signup and recovery get the tightest limits.
  - Signup: a fixed window per client IP in Redis, under `rl:api:signup:<ip>`, set by `rateLimits.signup` in platform config. An IPv6 client is counted by its /64. Over the limit: `429 rate_limited` with `Retry-After`.
  - While Redis is down, the limit fails closed: signup answers `500` rather than skipping the limit.
  - Behind Traefik, `TRUST_PROXY` must name it, or every client counts as Traefik's address.
- **PA-6** `/_/health` for liveness. `/_/ready` checks Postgres and Redis. Metrics on an internal port.

## Error codes

Every `401` carries `WWW-Authenticate: Bearer`. Service endpoints add their codes in step 2 (T06).

| Status | Code | When |
|---|---|---|
| `400` | `invalid_request` | A malformed request: invalid JSON, or a body that fails its schema. |
| `401` | `unauthorized` | No `Authorization: Bearer` key. |
| `401` | `invalid_key` | An unknown, revoked, or malformed key. |
| `401` | `wrong_key_type` | A payment key ([AK-4](accounts-and-keys.md)). |
| `404` | `not_found` | An unknown route. |
| `413` | `request_too_large` | The request body is over the limit. |
| `415` | `unsupported_media_type` | A content type the route doesn't take. |
| `429` | `rate_limited` | Over a per-IP limit (PA-5). |
| `500` | `internal_error` | Anything unexpected. Opaque: the details go to the log only (XC-7). |
