# Catalog and intents

Status: **draft**. Part of the [architecture overview](README.md).

Lets agents and people find services.

| | |
|---|---|
| Packages | `core`, `db`, `api`, `workers` (stats) |
| Owns | `catalog_entries` (search index), `service_stats`. The category list in platform config. |
| Depends on | [Service registry](service-registry.md), [Ledger](ledger.md) (`payments` rows), [Payment routing](payment-routing.md) (routed endpoints) |
| [Build step](README.md#7-build-order) | 13: the catalog. Intents (CI-6, CI-7) come after the MVP |

An agent that knows the platform but not the service sends an intent: a description of what it wants to do. The platform answers with services that can do it, with their prices, and recommends one. The agent picks one and calls it through the proxy.

## Requirements

- **CI-1** Index live registered services: title, summary, description, category, tags, and each route's summary and price. Update on activation, suspension, and price change.
- **CI-2** Index routed endpoints: host, path, last quote. Label them "Unverified" ([AR14](README.md#8-open-questions)).
- **CI-3** Categories are hierarchical IDs, such as `weather`, `finance/market-data`, or `ai/image-generation`, from the platform list.
- **CI-4** Stats per service and route come from `payments` rows: calls, success rate, p50 and p95 upstream latency. A worker aggregates them every few minutes. The proxy writes nothing extra.
- **CI-5** `GET /v1/catalog` lists and filters by category and text. `GET /v1/catalog/{id}` returns one service with its description, links, prices, and stats. The website reads only these.
  - Query: `category` (an ID; its subcategories match too), `q` (text), `method` (`credits`, `x402`, or `mpp`: services that take it), `maxPrice` (USD: the cheapest route costs at most this), `sort` (`popular`, calls over 30 days, the default; `price`; `newest`; `success`), `limit`, and `cursor`.
  - A list item: `{ id, title, summary, category, tags, priceFrom, currency: "USD", methods, stats: { calls30d, successRate, p50Ms, p95Ms }, verified, updatedAt }`. The list adds `categories: [{ id, title, count }]` and `next`.
  - One service adds `description`, `links`, `contact`, `routes: [{ key, method, path, summary, price, methods, stats }]`, `docs: { openapi, llms, skill }` (AR1), and `payUrl`.
  - Until step 13, the website serves this shape from fixtures ([WB-10](website-and-link-checker.md)).
**After the MVP** (owner, 2026-10-06T19:50:00+08:00): CI-6 and CI-7, intents. Agents find services through the catalog.

- **CI-6** `POST /v1/intents` takes a description and an optional budget per call. It returns candidates with prices and one recommendation.
  - v1 search: Postgres full-text.
  - Ranking: relevance, then price, success rate, and latency. Promoted results, if they ever exist, are labeled.
  - Routed endpoints rank below registered services.
- **CI-7** Prices in an intent response are informational. The `402` at call time is binding.
- **CI-8** Public and rate limited per IP. No key needed.

## As built in step 13

- **The index (CI-1):** the workers' `catalog_index` job runs every minute. It compiles every live service's active revision with the current platform config, and makes `catalog_entries` exactly those. A suspended or pending service leaves at the next run, and a price change shows. Each entry keeps when it was first listed, for `newest`. Search is Postgres full-text (`websearch_to_tsquery('english', q)`) over the title, summary, description, tags, category, and route summaries.
- **Routed endpoints (CI-2):** `routed_endpoints.last_price` holds the last quote (the target's price and the fee), from the proxy's registration. They follow the registered services, with no category filter or method filter set:
  - `id` is `routed:<host><path>`, `verified: false`, `stats` zero, and `link` the routing link;
  - `GET /v1/catalog/{id}` serves registered services only.
- **Stats (CI-4):** `service_stats`, written every 5 minutes by `service_stats` for the whole service (route `''`) and each keyed route. They count payments with a decision over 30 days. `successRate` is the billable share, and the latencies are p50 and p95 of `upstream_latency_ms`.
- **Pages:** `limit` is 1 to 100 (default 20). `cursor` is the offset as a string. The category counts follow the other filters. `rateLimits.documents` limits the catalog too.
