# Architecture

Status: **draft**.

This directory splits Service Router into components. This page is the overview: how the components fit together, the rules they share, how they deploy, and the order to build them in. Each component has its own doc ([section 1.5](#15-components)). A component doc says what the component does, what it owns, what it talks to, and what its implementation must do.

These docs are self-contained. When a component needs a fact from elsewhere, the fact is copied in.

**Requirement IDs.** Each requirement has an ID, such as `PX-3`. The prefix names the component. Cite IDs in tests, commits, and pull requests. An ID is fixed once a build step that covers it starts. After that, never reuse it: if the requirement is dropped, keep its number and mark it dropped.

**Adding a component.** Add a doc to this directory with the same layout: a one-line purpose, the info table, then `## Requirements` with a new ID prefix. Then add it to the index, the storage tables, and the build order below.

## 1. Overview

### 1.1 System map

```
public      Buyer agents ─────────────▶ Proxy             pay.servicerouter.ai
            People, seller tools ─────▶ Website           servicerouter.ai
                              └───────▶ Platform API      api.servicerouter.ai

internal    Proxy ──▶ Signer                  signs payments to x402 and MPP targets
            Proxy ──▶ Cardano facilitator     verifies and settles x402 on Cardano
            Proxy ──▶ Internal API            registers routed endpoints
            Workers                           verification, holds, settlements, deposits,
                                              payouts, treasury, stats
            Postgres 18, Redis 8              shared by our apps

external    Proxy ──▶ sellers' upstreams, x402 and MPP targets, CDP facilitator
            Cardano facilitator, Workers ──▶ Blockfrost
            Signer ──▶ chain RPCs, when a payment needs one
```

### 1.2 Hosts

| Host | Serves | App |
|---|---|---|
| `servicerouter.ai` | Landing page, catalog at `/discover`, service pages at `/discover/<service-id>`, top-up page, `llms.txt` | Website |
| `pay.servicerouter.ai` | `/service/<service-id>/<path>`: a registered service. `/<host>/<path>`: payment routing to any x402 or MPP API. `/`: the link checker. | Proxy |
| `api.servicerouter.ai` | `/v1/...`: accounts, keys, services, balances, catalog, agent docs. Intents come after the MVP | Platform API |

- **Paid traffic has its own host.** Seller and target responses can contain anything, so they never share an origin with the website or the Platform API. The host also deploys and scales on its own.
- **Paid URLs carry no version.** They end up in x402 Bazaar listings, generated OpenAPI documents, agent skills, and sellers' docs, so they never change. The seller config carries its own version.

### 1.3 Deployables


Why one image and not one per app:

- **No version skew.** Every app in a stack runs the same tag. The apps share the database schema, the Redis invalidation channel, and the internal API, so they must never run different builds.
- **Isolation is per service, not per image.** Each app is its own stack service, with its own replicas, networks, and secrets. A container gets only its own app's secrets.
- **Shared dependencies.** Proxy, Platform API, and Workers depend on the same packages: `common`, `core`, `db`, and `payments`. Node loads only what an app imports, so the Signer never runs other apps' code, even though the image contains it.
- **One build.** CI builds, scans, and pushes one image per commit.

An app gets its own image only if it can't use the shared build: the website. It is a Next.js app ([AR11](#8-open-questions)) that builds separately, `servicerouter-web` on ghcr.io.

| App | Image | Host | Exposure | Replicas | Keys it holds |
|---|---|---|---|---|---|
| Proxy | Ours, app `proxy` | `pay.servicerouter.ai` | Public | 2+, stateless | Private key that opens seller secrets. CDP API key. Shared secrets for the Signer, the internal API, and MPP challenges. None of them moves funds. |
| Platform API | Ours, app `api` | `api.servicerouter.ai`, plus an internal port | Public. Internal port private. | 2+ | Public key that seals seller secrets. Deposit account public key. SMTP credentials, after the MVP. |
| Workers | Ours, app `workers` | None | Private | 1+, one runner per job | Payout key. Blockfrost key. SMTP credentials, after the MVP. |
| Signer | Ours, app `signer` | Internal | Private | 1–2 | Hot-wallet keys that pay routed targets. |
| Website | Ours, `servicerouter-web` | `servicerouter.ai` | Public | 2 | None. A master key passes through a visitor's browser only, never the web server ([WB-8](website-and-link-checker.md)). |
| Cardano facilitator | `cardanofoundation/cardano-x402-facilitator`, plus its own Postgres 17 | Internal | Private | 1 | Blockfrost project ID. No funds. |

Shared infrastructure: Postgres 18 and Redis 8.

### 1.4 Packages and stack

```
packages/
  common/     errors, Secret, logging, process lifecycle, money, strict YAML loader, Outbound HTTP,
              the HTTP server every app runs
  core/       domain models, service config (schema, checks, compiler), platform config, asset registry,
              secret sealing, keys, and ports such as AuditLog and InvalidationBus
  db/         Drizzle schema, migrations, repositories, and the Redis client with its adapters
              (invalidation channel, rate limits)
  payments/   rails (credits, x402, MPP), the combined 402, payment routing logic
  proxy/      app: pay.servicerouter.ai
  api/        app: api.servicerouter.ai and the internal API
  workers/    app: background jobs
  signer/     app: signs payments to routed targets
  web/        app: servicerouter.ai
  testing/    fakes and builders, and a Postgres database and Redis prefix per test file, for tests only
```

Dependency rules:

- `common` depends on nothing internal. `core` depends on `common`. `db` depends on `core` and `common`.
- `payments` depends on `core` and `common` only. It declares ports, such as `CreditsLedger`, `ReplayStore`, and `PaymentRecorder`. `db` and the Redis adapters implement them.
- `proxy`, `api`, and `workers` may depend on any package above. They wire the implementations.
- `signer` depends on `common`, `core` (platform config, the asset registry), and `db` (its `signatures` table), never on another app's package (B-3, step 12). `web` talks to the public Platform API only.
- `testing` is a dev dependency. Only test code imports it, never `src/`.
- Use package imports across workspaces and `.js` relative imports inside a package. Keep public exports in each `src/index.ts`.

| Area | Choice |
|---|---|
| Runtime | Node.js 24+, ESM, TypeScript with `strict` and `noUncheckedIndexedAccess` |
| Workspace | npm workspaces. `package-lock.json` is authoritative. |
| HTTP | Fastify 5. Forwarding with `@fastify/reply-from` (undici). |
| Database | Postgres 18, Drizzle ORM with `pg`, drizzle-kit migrations |
| Cache and coordination | Redis 8, `redis` client v6. AOF on, `noeviction`. |
| Validation | ajv, JSON Schema |
| YAML | `yaml`, strict mode |
| Logging | pino, JSON to stdout |
| x402 | `@x402/core`, `@x402/evm`, `@x402/svm`, `@x402/cardano`, pinned to one exact version and upgraded together: 2.28.0 since step 5. `@x402/svm` brings `@solana/kit` 5.x as its peer. |
| MPP | `mppx`, pinned to an exact version. It is pre-1.0. |
| EVM and Tempo | `viem` |
| Cardano | Evolution SDK (`@evolution-sdk/evolution`), Blockfrost |
| Metrics | `@prometheus-io/client`, the successor of `prom-client` |
| Website | Next.js 16 (App Router) and React 19, in `packages/web`, built separately with its own image ([AR11](#8-open-questions)). Inter and JetBrains Mono from Fontsource. `qrcode` for the top-up page. |
| Tests | vitest: unit, integration, functional |

Don't add a second HTTP framework, ORM, logger, or validator. The website is the exception: its frontend framework builds separately ([AR11](#8-open-questions)).

### 1.5 Components

| Plane | Component | IDs | Packages | Build step |
|---|---|---|---|---|
| Foundation | [Common kit](common-kit.md) | `CK` | `common` | 1 |
| Foundation | [Outbound HTTP](outbound-http.md) | `OH` | `common` | 1 |
| Foundation | [Platform config](platform-config.md) | `PC` | `core` | 1 |
| Control plane | [Service registry](service-registry.md) | `SR` | `core`, `db`, `api` | 2 |
| Control plane | [Secrets](secrets.md) | `SC` | `core`, `db`, `api`, `proxy` | 2 |
| Control plane | [Accounts and keys](accounts-and-keys.md) | `AK` | `core`, `db`, `api`, `web` | 2, 4, 9 |
| Control plane | [Ownership verification](ownership-verification.md) | `OV` | `core`, `api`, `workers` | 8 |
| Control plane | [Platform API](platform-api.md) | `PA` | `api` | 2 onward |
| Data plane | [Proxy](proxy.md) | `PX` | `proxy` | 3 |
| Data plane | [Payment rails](payment-rails.md) | `PR` | `payments`, `core` | 4–7 |
| Data plane | [Ledger](ledger.md) | `LG` | `core`, `db` | 4 |
| Data plane | [Cardano facilitator](cardano-facilitator.md) | `CF` | None: an external image | 6 |
| Data plane | [Payment routing](payment-routing.md) | `RT` | `payments`, `proxy`, `db`, `api` | 12 |
| Data plane | [Signer](signer.md) | `SG` | `signer` | 12 |
| Money operations | [Workers](workers.md) | `WK` | `workers` | 4 onward |
| Money operations | [Deposits](deposits.md) | `DP` | `core`, `db`, `workers`, `api` | 9 |
| Money operations | [Payouts](payouts.md) | `PO` | `core`, `db`, `workers`, `api` | 11 |
| Money operations | [Treasury](treasury.md) | `TR` | `core`, `db`, `workers`, `api` | 11 |
| Discovery | [Agent docs](agent-docs.md) | `AD` | `core`, `api` | 10 |
| Discovery | [Catalog and intents](catalog-and-intents.md) | `CI` | `core`, `db`, `api`, `workers` | 13. Intents after the MVP |
| Discovery | [Website and link checker](website-and-link-checker.md) | `WB` | `web`, `proxy` | 15 |
| Discovery | [Config assistant](config-assistant.md) | `CA` | `api` | 14 |

The product describes five platform components. They map here:

| Product component | What it does | Components here |
|---|---|---|
| Proxy | Answers an unpaid call with one `402` that lists every payment method. Forwards paid calls to the upstream. | [Proxy](proxy.md), [Payment rails](payment-rails.md) |
| Credits ledger | Holds prepaid balances. Sub-cent calls cost no on-chain fee per call. | [Ledger](ledger.md) |
| Conversion | Takes the buyer's asset in and pays the seller's asset out. | [Treasury](treasury.md) |
| Routing | Pays any x402 or MPP API for the buyer. | [Payment routing](payment-routing.md), [Signer](signer.md) |
| Cardano facilitator | Verifies and settles x402 payments on Cardano. | [Cardano facilitator](cardano-facilitator.md) |

## 2. Architecture rules

Every component follows these rules.

1. **The hot path stays local.** The proxy answers from its in-process cache, Postgres, Redis, facilitators, and the Signer. It never calls the Platform API while a buyer waits, and never fetches an OpenAPI document.
2. **Replicas are stateless.** Anything two replicas must agree on lives in Postgres or Redis.
3. **One owner per table.** A component writes only its own tables ([section 5](#5-storage)). Others read through its repository or call it.
4. **Money moves once.** Every money movement is one ledger transaction, keyed by a payment or job ID with a unique constraint. A retry never moves money twice.
5. **Decide, record, then act.** The billing decision is written on the payment row before capture or settlement. A worker can then finish any payment a crash interrupted.
6. **Keys that move funds live in two apps.** The Signer holds small hot wallets for paying routed targets. Workers hold the payout key. The proxy and the Platform API hold no key that moves funds. Receiving addresses need no online key.
7. **Outside URLs go through Outbound HTTP.** Any URL that a seller, a buyer, or a target controls is fetched through [Outbound HTTP](outbound-http.md).
8. **Ports and adapters.** Domain packages (`core`, `payments`) declare ports. Apps wire adapters. Time and ID generation are ports too.
9. **Compile once.** Seller configs compile into frozen runtimes at activation and on cache load. Never per request.
10. **Nothing leaks.** No upstream details in errors. No bodies in logs. No credential outside `Secret`.
11. **Reuse before building.** When a maintained, open-source service already does a job, run it as a service in the stack instead of writing a package. The [Cardano facilitator](cardano-facilitator.md) is one.

## 3. Request flows

### 3.1 A paid call to a registered service

1. **Proxy:** the first path segment is `service`. The second is the service ID.
2. **Proxy:** gets the compiled runtime from its cache, or from the **Service registry** on a miss. Matches the operation. The price comes from the runtime.
3. **Proxy:** checks rate limits.
4. **Payment rails:** detect the credential. None → the combined `402`. One → authorize it: hold credits in the **Ledger**, verify x402 through a facilitator (CDP, or the **Cardano facilitator**), or verify MPP.
5. **Proxy:** forwards to the upstream through **Outbound HTTP**, with the seller's credentials from **Secrets**.
6. **Proxy:** decides whether the response is billable and records it on the payment row. Then finalizes (capture or settle) or aborts (release or cancel).
7. **Ledger:** books seller earnings and the platform fee. The response goes out with a receipt.

### 3.2 A routed call

1. **Proxy:** the first path segment is a hostname.
2. **Payment routing:** checks the host against our hosts, the blocklist, and the owner's opt-out. Takes the quote from the cache, or probes the target.
3. Not a `402` → `400 not_payable`. No option we can pay → `502 unsupported_payment`.
4. **Payment routing:** quote = target price + routing fee.
5. **Payment rails:** a payment key → hold the quote and go on in the same request. No credential → the combined `402` at the quote. An x402 or MPP credential → verify it against the quote.
6. **Signer:** signs the target payment, within the quote and its spend limits.
7. **Proxy:** retries the target with the payment.
8. Target `2xx` → finalize the buyer's payment. Anything else → abort it. The buyer isn't charged. If the target kept our payment, the **Ledger** books a routing loss.
9. **Proxy:** after the response, registers the endpoint through the **Internal API**.

### 3.3 Seller onboarding

1. **Accounts:** `POST /v1/accounts` returns a master key. Optionally, the **Config assistant** drafts a config from the seller's OpenAPI link.
2. **Platform API:** `PUT /v1/services/{id}` with the config and its secrets in one request. The **Service registry** validates the config, fetches OpenAPI documents, and stores a revision. **Secrets** seals the upstream credentials.
3. **Ownership verification:** the seller publishes the account's token. Every upstream host is checked.
4. **Service registry:** all hosts verified → activation → invalidation event. The **Proxy** serves the service. **Agent docs** regenerate. The service appears in the x402 Bazaar after its first Base payment settles through CDP.
5. **Later changes** apply at once. A change to `payouts` waits until every host's file lists its confirmation token.
6. **Payouts:** monthly, in USDM on Cardano.

### 3.4 Buyer onboarding and top-up

1. **Accounts, Deposits:** `POST /v1/accounts` returns a master key and a top-up link. The account gets a Cardano deposit address.
2. **Accounts:** `POST /v1/keys` with the master key creates a payment key with limits. The agent that spends gets only the payment key.
3. **Website:** the user opens the top-up page and sends USDM.
4. **Deposits:** the balance is credited once, after the confirmation threshold.
5. **Proxy:** the agent calls services with its payment key.

## 4. Cross-cutting

- **XC-1** Logs: pino JSON to stdout. Loki collects them.
- **XC-2** Metrics: Prometheus on an internal port of every app. Minimum set:
  - requests and latency by service, route, status, and rail;
  - verify and settle latency and failures by rail and network;
  - facilitator errors;
  - holds, captures, and releases;
  - runtime cache hit rate and invalidation lag;
  - upstream latency and errors;
  - ledger drift and treasury balances;
  - ownership check failures;
  - Signer spend per network, routing quotes, and routing losses;
  - job staleness.

  Every app exports Node's default metrics, `http_requests_total`, and `http_request_duration_seconds`, labeled by method, route (the pattern, or `unmatched`), and status.
- **XC-3** Health: every app has a liveness endpoint and a readiness endpoint. Readiness covers the app's dependencies.
  - `/_/health` answers while the process runs. `/_/ready` runs the app's checks at once, each under a 2 s deadline, and answers `200` or `503` with `{ "status": "ready" | "not_ready", "checks": { "<name>": "ok" | "failed" } }`. Reasons go to the log only.
  - An app without a public port, such as Workers, serves both on its metrics port.
- **XC-4** One `audit_log` table for money movements, config changes, secret writes, key changes, account recovery, and internal API calls: who, what, when. Every component writes it through one repository.
  - An entry holds the actor (an account, the internal API, or a job), a stable dotted action such as `service.submit`, the subject, the request ID when there is one, and JSON details. The ID and time come from the ports (CK-5).
  - The repository only appends. It refuses a `Secret`, or any other value that isn't plain JSON, anywhere in the details.
- **XC-5** The request ID comes from `x-request-id` or is generated at the edge. It goes on every internal call and every log line. An incoming ID that doesn't match the request ID pattern (CK-9) is replaced.
- **XC-6** Each app connects with its own Postgres role and Redis ACL user. Each gets rights only to the tables and key prefixes it uses.
- **XC-7** Privacy: never log request or response bodies. Log metadata only: service, route, status, sizes, latency, rail, amount, and request ID. Never return internal errors or upstream details to a client.

## 5. Storage

Postgres tables by owner. The names are suggestions. The owner is the rule ([rule 3](#2-architecture-rules)).

| Owner | Tables |
|---|---|
| [Service registry](service-registry.md) | `services`, `service_revisions` |
| [Secrets](secrets.md) | `service_secrets` |
| [Accounts and keys](accounts-and-keys.md) | `accounts`, `api_keys`, `email_links` |
| [Ownership verification](ownership-verification.md) | `verification_tokens`, `payout_confirmations`, `upstream_hosts` |
| [Ledger](ledger.md) | `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `balances`, `payments`, `key_daily_spend`, `key_total_spend` |
| [Payment routing](payment-routing.md) | `routed_endpoints`, `host_blocklist`, `target_payments` |
| [Signer](signer.md) | `signatures` |
| [Deposits](deposits.md) | `deposit_addresses`, `deposits` |
| [Payouts](payouts.md) | `payout_runs`, `payouts` |
| [Treasury](treasury.md) | `treasury_transfers`, `reconciliation_runs` |
| [Agent docs](agent-docs.md) | `service_documents` |
| [Catalog and intents](catalog-and-intents.md) | `catalog_entries`, `service_stats` |
| [Cross-cutting](#4-cross-cutting) | `audit_log` |

The [Cardano facilitator](cardano-facilitator.md) keeps its settlement journal in its own Postgres 17. Our apps never touch that database.

Migrations are SQL files generated by drizzle-kit, in `packages/db/migrations/`.

Redis runs with AOF on and `noeviction`. The MPP replay store must never lose a key. Every connection has a prefix for its keys and channels. It is empty in deployments, and unique per test file in tests.

| Key space | Owner | Use |
|---|---|---|
| Channel `invalidation` | Service registry, Accounts and keys | Runtime and key cache invalidation. Events are `{ "kind": "service" \| "account" \| "key", "id" }`. |
| `rl:*` | Proxy, Platform API (`rl:api:*`) | Rate limits |
| `mpp:*` | Payment rails | MPP replay store |
| `quote:*`, `optout:*` | Payment routing | Quote cache, opt-out cache |
| `spend:*` | Signer | Spend limits |

## 6. Deployment

- Images are built in CI and pushed to ghcr.io. Nobody pushes images by hand. Third-party images are pinned to a tag, never `latest`.
- Every one of our services in a stack uses the same image tag: the commit SHA. A deploy moves them all together ([section 1.3](#13-deployables)).
- Every stack service sets its `command`. The image's default command isn't relied on.
- Stacks run on Docker Swarm. Staging and production are separate stacks. Staging runs on testnets, with its own key prefixes ([PC-7](platform-config.md)).
- Public apps (Proxy, Platform API, Website) join the `traefik-slave` network and carry Traefik labels.
- Internal services (Signer, Cardano facilitator, the internal API port, Postgres, Redis) get no Traefik labels and no published ports.
- Postgres joins the `pgadmin-private` network.
- Apps that export metrics carry the `prometheus-job` and `prometheus-port` labels.
- Secrets come from stack environment variables, set at deploy time. They are never in the repo.
- Apps read `DATABASE_URL` and `REDIS_URL` from the environment. They carry passwords, so they never go in platform config (S1-D2).
- Ports come from the environment: `PORT` for the public listener and `METRICS_PORT` for metrics, with `HOST` defaulting to `0.0.0.0`. Defaults: proxy 8080 and 9080, API 8081 and 9081, workers 9082 only, Signer 8083 and 9083, website 8084 and 9084. The `prometheus-port` label is the app's metrics port.
- The Platform API reads `TRUST_PROXY`, Traefik's addresses or network, so its per-IP limits see the client's address rather than Traefik's.
- The secrets key pair ([SC-2](secrets.md)): the Platform API reads `SECRETS_PUBLIC_KEY`, and the proxy `SECRETS_PRIVATE_KEYS`, one or more PEM keys. A literal `\n` in the value becomes a newline, so a key fits on one line.
- CORS on the public hosts exposes the payment headers ([PX-16](proxy.md)).

## 7. Build order

Build one step at a time. Don't start a step before the previous one is done.

**MVP scope** (owner, 2026-10-06T19:50:00+08:00):

- **Email is out of the MVP** ([AR19](#8-open-questions)): AK-10 to AK-14, the email pages, email notices, and the SMTP relay.
- **Intents are out of the MVP**: CI-6 and CI-7. The catalog stays.

**Done means:**

- Typecheck, build, and unit, integration, and functional tests pass in CI.
- Tests are offline. They reach only localhost. Upstreams, facilitators, Blockfrost, and Tempo RPC are fakes from `packages/testing`. Test keys are generated in the test run.
- Tests cite the requirement IDs they cover.
- The component docs match what was built.

**Rules:**

- A step builds only the requirements it needs from each component.
- When a step needs a component that comes later, put a fake or an admin endpoint behind the same port. Example: step 4 credits balances through the internal API until deposits exist in step 9.

### Step 1. Scaffold

- **Build:** [Common kit](common-kit.md), [Outbound HTTP](outbound-http.md), [Platform config](platform-config.md), the workspace, app shells with health endpoints, Docker Compose with Postgres 18 and Redis 8, CI.
- **Done when:** CI is green and runs all three test levels. `npm run dev` starts the proxy and the API. `packages/testing` has the fake upstream and database helpers.

### Step 2. Seller config

- **Build:** [Service registry](service-registry.md), [Secrets](secrets.md), [Accounts and keys](accounts-and-keys.md) (accounts, master keys), [Platform API](platform-api.md) (account and service endpoints).
- **Done when:** an invalid config returns errors with line and column. A submit with secrets stores them sealed, with only their names in the revision, and a failed submit stores nothing. Secrets can't be read back. Rollback switches the active revision. Rotating the master key stops the old one at once.

### Step 3. Free forwarding

- **Build:** [Proxy](proxy.md): dispatcher, runtime cache, matcher, forwarder. Services are free in this step.
- **Done when:** against the fake upstream, method, path, query, and body pass through. `Location` is rewritten. Cookies are stripped. Unknown operations get `404`. Private IPs are blocked. A config change reaches the proxy without a restart.

### Step 4. Credits

- **Build:** [Accounts and keys](accounts-and-keys.md) (payment keys and their limits), [Ledger](ledger.md), [Payment rails](payment-rails.md) (credits, the combined `402`), [Workers](workers.md) (hold expiry), the earnings endpoint, the admin credit endpoint.
- **Done when:** concurrent calls never overdraw the balance or pass a key's daily budget or allowance (integration test). A master key on the proxy and a payment key on the Platform API both get `401 wrong_key_type`. A revoked key stops working at once. Non-billable statuses release the hold. Two credentials get `400`. Credits overhead is under 50 ms p95 in a load test against the fake upstream.

### Step 5. x402 on Base and Solana

- **Build:** [Payment rails](payment-rails.md) (x402, facilitator registry, settle outcomes), [Workers](workers.md) (settlement follow-up).
- **Done when:** a payload signed by the official `@x402` client packages gets `200` through the fake facilitator. A failed upstream call is never settled. Earnings appear in the ledger. A `settlement_pending` answer sends the response and the worker finishes the settlement.

### Step 6. x402 on Cardano

- **Build:** the [Cardano facilitator](cardano-facilitator.md) service in the stack, the Cardano entry in `accepts`.
- **Done when:** in functional tests, a USDM payment signed with `@x402/cardano` gets `200` through the fake facilitator, and every facilitator answer shape is handled ([CF-6](cardano-facilitator.md)). A real USDM payment on `cardano:mainnet` settles through the facilitator service, with CF-8's checks done ([AR18](#8-open-questions)). A repeated settle never submits twice.

### Step 7. MPP

- **Build:** [Payment rails](payment-rails.md) (MPP).
- **Done when:** a valid credential gets `200` through the fake Tempo RPC. A replayed credential is rejected across two proxy instances. A failed upstream call is never broadcast, so the buyer pays nothing.

### Step 8. Ownership

- **Build:** [Ownership verification](ownership-verification.md).
- **Done when:** a service stays offline until every host is verified. Removing the token leads to a notice, then suspension after the grace period (fake clock). Restoring it brings the service back. A payout change waits until every host lists its confirmation token, while the active revision keeps serving. An unconfirmed change is dropped after 7 days.

### Step 9. Deposits

- **Build:** [Deposits](deposits.md), with the top-up data endpoint (DP-5). Email, recovery, and notices are out of the MVP. The top-up page is part of the website, in step 15.
- **Done when:** a deposit seen through the fake Blockfrost credits the balance exactly once, after the confirmation threshold. `GET /v1/topup/{token}` shows the account's address and the deposit's status.

### Step 10. Agent docs

- **Build:** [Agent docs](agent-docs.md), including Bazaar metadata.
- **Done when:** the generated document is valid OpenAPI 3.x, points `servers[0].url` at the pay URL, and its prices match the active config. A client built only from it calls the service through the proxy.

### Step 11. Payouts and treasury

- **Build:** [Payouts](payouts.md), [Treasury](treasury.md).
- **Done when:** a payout run builds and submits correct transactions through the fake Blockfrost. Running it again moves nothing. Reconciliation alerts on drift.

### Step 12. Payment routing

- **Build:** [Signer](signer.md), [Payment routing](payment-routing.md), the link checker's endpoint (`GET /_/check`, RT-19). The link checker page is part of the website, in step 15.
- **Done when:**
  - With a fake x402 target and test wallets, a payment-key call returns the target's response in one request. The buyer pays the quote. The ledger shows the target price in treasury and the fee in routing fees.
  - Without a credential, the proxy answers with the combined `402` at the quote. A retry with a signed x402 payment succeeds.
  - A failing target → the buyer isn't charged.
  - A target that raises its price on retry → `502 quote_exceeded`. Nothing is signed.
  - `GatewayWalletBatched` options are skipped.
  - The Signer refuses above the quote, above the per-call maximum, and above its spend limits.
  - Our hosts and opted-out hosts → `400 host_not_allowed`.
  - Each endpoint is registered once.
  - `GET /_/check` returns the quote and the routing link without paying.

### Step 13. Discovery

- **Build:** [Catalog and intents](catalog-and-intents.md): the catalog and its stats. Intents are out of the MVP. The catalog pages are part of the website, in step 15.
- **Done when:** `GET /v1/catalog` lists live services, filtered by category and text, ranked by the default ranking. Routed endpoints are labeled "Unverified" and rank below. Suspending a service removes it from the catalog. A price change shows up in the catalog.

### Step 14. Config assistant

- **Build:** [Config assistant](config-assistant.md).
- **Done when:** a sample OpenAPI document gives a draft that passes validation. Nothing is submitted. With the LLM faked, the mechanical mapping matches a fixture.

### Step 15. Website

- **Build:** the [Website](website-and-link-checker.md), beside steps 7 to 14 (owner, 2026-10-06T19:50:00+08:00), with sample data where an endpoint isn't built yet ([WB-10](website-and-link-checker.md)). Tasks T15 (the app, public pages, agent files) and T16 (the console):
  - the landing page;
  - the catalog at `/discover`, and service pages;
  - the top-up page;
  - the link checker page, served by the proxy;
  - the platform guide and skills at `servicerouter.ai`;
  - the console (WB-8).

- **Done when:**
  - every page renders from the public Platform API only (WB-2);
  - the top-up page shows a real account's deposit address;
  - the link checker shows a quote without paying;
  - `servicerouter.ai/llms.txt` serves the platform guide;
  - the console manages payment keys with a master key, as WB-8's requirements say;
  - the logo, favicon, and social images come from the logo generator's vector paths.

## 8. Open questions

The implementing agent uses these defaults until the product owner answers. Keep each default in one place, so it's easy to change.

| # | Question | Default |
|---|---|---|
| AR1 | Where are generated agent docs served? | `api.servicerouter.ai/v1/services/{id}/openapi.json`, `…/llms.txt`, `…/skill.md`. The service page links to them. |
| AR2 | Which header carries the credits receipt? | `Servicerouter-Receipt`, with the payment ID and the USD amount, as a structured-field dictionary: `id="pay_…", amount="0.001", currency="USD"`. |
| AR3 | What is the x402 response buffer limit? | 10 MiB. Above it, `502 response_too_large`, uncharged. |
| AR4 | What daily budget does a new payment key get? | $5 a day. No allowance, maximum price, or expiry unless the owner sets them. |
| AR5 | When does a daily budget reset? | Midnight UTC. |
| AR6 | How is the fee rounded? | Down to the micro-USD. The seller gets the remainder. |
| AR7 | Do routed endpoints appear in the x402 Bazaar under our URL? | No. Routed `402`s carry no Bazaar metadata. |
| AR8 | What are the Signer's limits? | $1 per call. $100 a day per network. Operators change them in platform config. |
| AR9 | What prefixes do keys use? | Master keys: `srm_live_…`, and `srm_test_…` in staging. Payment keys: `sr_live_…`, and `sr_test_…` in staging. Set in platform config ([PC-7](platform-config.md)). |
| AR10 | Does an operator approve mainnet payouts? | Yes, every run. |
| AR11 | Which stack does the website use? | **Answered (product owner, 2026-10-06T19:50:00+08:00):** Next.js 16 with the App Router and React 19, built separately, with its own image ([section 1.3](#13-deployables)). Pages render on the server, so the landing page and the catalog are indexable. The console runs in the browser. The website also gets a console for people, signed in with a master key ([WB-8](website-and-link-checker.md)). |
| AR12 | How many Cardano confirmations make a payment settled? | `0`: block inclusion. The facilitator's default is `1`. Measure latency on mainnet, in step 6's live check, before changing it. |
| AR13 | Do we pay routed targets on Cardano too? | No. Base, Solana, and Tempo. |
| AR14 | Where does the catalog list routed endpoints? | A filter on `/discover`, labeled "Unverified". |
| AR15 | Do we route to targets that also need their own API key? | Yes, when the key is in a custom header, such as `X-Api-Key`. A key in `Authorization` can't pass: it clashes with payment keys and MPP. |
| AR16 | Do we pay targets with Circle Gateway nanopayments? | Not in v1. We skip those options. |
| AR17 | A path with an ID, such as `/v1/tx/<hash>`, registers a new endpoint per ID. Do we cap them? | Up to 1,000 routed endpoints per host. Beyond that, log and don't register. |
| AR18 | When is Cardano enabled on mainnet? | **Answered (product owner, 2026-10-06T19:50:00+08:00):** from step 6, since the MVP runs on mainnet only. CF-8's checks are step 6's live check, and the owner signs off on its result. |
| AR19 | How do we send email? | **Answered (product owner, 2026-10-06T19:50:00+08:00):** no email in the MVP. AK-10 to AK-14, the email pages (WB-1, WB-7), email notices (OV-7, OV-10, AK-13), and the SMTP relay (PC-2) come after it. A lost master key can't be recovered in the MVP, and signup says so (AK-1). |
| AR20 | At what load is PX-19's 50 ms checked? | **Answered (product owner, MVP):** 300 paid requests per second per proxy replica, sent at a fixed rate. One replica handled about 700 paid calls per second on a laptop in step 4. Past a replica's capacity, add replicas. |
