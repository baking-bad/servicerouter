# Catalog and intents

Status: **draft**. Part of the [architecture overview](README.md).

Lets agents and people find services.

| | |
|---|---|
| Packages | `core`, `db`, `api`, `workers` (stats) |
| Owns | `catalog_entries` (search index), `service_stats`. The category list in platform config. |
| Depends on | [Service registry](service-registry.md), [Ledger](ledger.md) (`payments` rows), [Payment routing](payment-routing.md) (routed endpoints) |
| [Build step](README.md#7-build-order) | 13 |

An agent that knows the platform but not the service sends an intent: a description of what it wants to do. The platform answers with services that can do it, with their prices, and recommends one. The agent picks one and calls it through the proxy.

## Requirements

- **CI-1** Index live registered services: title, summary, description, category, tags, and each route's summary and price. Update on activation, suspension, and price change.
- **CI-2** Index routed endpoints: host, path, last quote. Label them "Unverified" ([AR14](README.md#8-open-questions)).
- **CI-3** Categories are hierarchical IDs, such as `weather`, `finance/market-data`, or `ai/image-generation`, from the platform list.
- **CI-4** Stats per service and route come from `payments` rows: calls, success rate, p50 and p95 upstream latency. A worker aggregates them every few minutes. The proxy writes nothing extra.
- **CI-5** `GET /v1/catalog` lists and filters by category and text. `GET /v1/catalog/{id}` returns one service with its description, links, prices, and stats. The website reads only these.
- **CI-6** `POST /v1/intents` takes a description and an optional budget per call. It returns candidates with prices and one recommendation.
  - v1 search: Postgres full-text.
  - Ranking: relevance, then price, success rate, and latency. Promoted results, if they ever exist, are labeled.
  - Routed endpoints rank below registered services.
- **CI-7** Prices in an intent response are informational. The `402` at call time is binding.
- **CI-8** Public and rate limited per IP. No key needed.
