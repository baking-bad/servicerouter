# Payment routing

Status: **draft**. Part of the [architecture overview](README.md).

Pays any x402 or MPP API for the buyer. The API's owner doesn't sign up or change anything. Any x402 tool on Base or Solana becomes payable from Cardano or with credits.

| | |
|---|---|
| Packages | `payments` (`routing` module: target parsing, challenge parsing, option choice, quotes), `proxy` (handler), `db` (repositories), `api` (internal endpoints) |
| Owns | `routed_endpoints`, `host_blocklist`, `target_payments`. The quote cache and the opt-out cache in Redis. |
| Depends on | [Payment rails](payment-rails.md), [Ledger](ledger.md), [Signer](signer.md), [Outbound HTTP](outbound-http.md), [Ownership verification](ownership-verification.md) (file parser) |
| [Build step](README.md#7-build-order) | 12 |

## How it works

The buyer puts `pay.servicerouter.ai/` in front of the target URL and drops `https://`:

```
https://pay.servicerouter.ai/api.example.com/v1/pools?limit=10
  → https://api.example.com/v1/pools?limit=10
```

The URL has the host, not the full target URL: some clients and proxies collapse `//` into `/`, so `https://` would break. The target is always HTTPS.

| The buyer pays the platform | The platform pays the target |
|---|---|
| Credits, x402 on Cardano, Base, or Solana, MPP | USDC on Base, USDC on Solana, MPP on Tempo |

- **With a payment key:** one request. The platform sees the target's `402`, pays it at once from its own funds, and returns the result. No `402` goes back to the agent.
- **Without an account:** the platform answers with its own `402`, listing every method it accepts. The agent pays the platform. The platform pays the target and returns the result.
- The platform never pays the target more than it quoted to the buyer.
- If the target fails, the buyer isn't charged.
- The platform doesn't bridge tokens per call. It holds funds on every network it pays on and rebalances the treasury separately ([Treasury](treasury.md)).
- The fee is added on top of the target's price, and the buyer pays it. The target gets its full price at once, in its own protocol.

**Circle Gateway nanopayments.** Some x402 targets also accept Circle Gateway nanopayments. The payer deposits USDC into Circle's Gateway Wallet contract once, then signs an offchain authorization per call against the `GatewayWalletBatched` domain. Circle settles net positions in batches. These options use `scheme: exact` and the same USDC contract as plain payments. Only `extra.name: GatewayWalletBatched` marks them. Our plain USDC signature fails against them. Example: on 2026-10-06T19:50:00+08:00, QuickNode's x402 endpoint offered USDC on Base at $10 (a prepaid credit drawdown), $0.001 (a plain call), and $0.0001 (a Gateway nanopayment).

## Requirements

- **RT-1** Parse `/<host>/<path>?<query>`. The host has at least one dot and an optional port. An IP address → `400 invalid_target`. The target is `https://<host>/<path>?<query>`.
- **RT-2** Refuse with `400 host_not_allowed`:
  - `servicerouter.ai` and its subdomains, so `pay.servicerouter.ai/pay.servicerouter.ai/…` can't loop;
  - sellers' custom domains;
  - hosts that resolve to our IP addresses ([OH-5](outbound-http.md));
  - blocklisted hosts;
  - hosts whose `.well-known/servicerouter.json` has `routing: false` ([Ownership verification](ownership-verification.md)).

  Cache the opt-out per host for a day. On a miss, fetch the file alongside the probe, with a short timeout. A failed fetch means no opt-out.
- **RT-3** Probe: send the request without payment, with the same method, path, query, body, and allowed headers. Not a `402` → `400 not_payable`, and the body is dropped: we only route paid calls. A `402` → parse the x402 `PAYMENT-REQUIRED` header (v2), the v1 JSON body, or an MPP `WWW-Authenticate: Payment` challenge.
- **RT-4** Choose an option:
  - a supported scheme (`exact` in v1);
  - a network we pay on (Base, Solana, Tempo);
  - an asset in the registry, pegged 1:1 to USD;
  - not `extra.name: GatewayWalletBatched` ([AR16](README.md#8-open-questions));
  - the cheapest of the rest. A large prepaid option, such as a $10 credit drawdown, looks like an expensive call. The cheapest rule skips it while a per-call option exists. The quote cap protects the buyer otherwise.

  None → `502 unsupported_payment`. The buyer isn't charged.
- **RT-5** Quote = target price + fee. The fee is `routingFeeBps` from platform config, or the routed endpoint's own `fee_bps`. Cache the quote by method and URL for a short TTL in Redis. A repeat call within the TTL skips the probe.
- **RT-6** The buyer side reuses the payment rails with the quote:
  - payment key → hold the quote and go on, in the same request;
  - no credential → the combined `402` at the quote;
  - x402 or MPP credential → verify it against the quote.
- **RT-7** Pay the target only after the buyer's payment is authorized. Ask the [Signer](signer.md) for the payment, then retry the target through Outbound HTTP.
- **RT-8** If the retry's `402` asks for more than the quoted target price, stop with `502 quote_exceeded`. The buyer isn't charged. The Signer also refuses anything above the quote.
- **RT-9** Target `2xx` → finalize the buyer's payment. Anything else → abort it. If the target settled our payment anyway, as its `PAYMENT-RESPONSE` shows, book a routing loss.
- **RT-10** The response follows the proxy's rules ([PX-6](proxy.md), [PX-7](proxy.md), [PX-9](proxy.md)), with `Location` rewritten to `https://pay.servicerouter.ai/<host>/…`. Strip the target's payment headers and add ours.
- **RT-11** Record both legs: the buyer leg in `payments` (`kind: routed`), the target leg in `target_payments` with the network, asset, amount, `payTo`, Signer reference, and the target's receipt.
- **RT-12** After the response, register the endpoint: `PUT /internal/v1/routed-endpoints` with `{ "host": "api.example.com", "path": "/v1/pools" }`.
  - Only for endpoints that answered `402`.
  - Never for our hosts, or for hosts that registered services use as upstreams.
  - Idempotent, and off the hot path: a bounded in-memory queue and a local seen-set. A lost registration is fine: the next call registers it.
  - At most 1,000 endpoints per host ([AR17](README.md#8-open-questions)).
- **RT-13** A routed endpoint row: `host`, `path` (without the query; `host` and `path` are the key), `fee_bps` (`null` means the default), `created_at` (the first routed call). Nothing more: it isn't a config.
- **RT-14** Claiming: when the owner verifies the host and submits a seller config, the host becomes a registered service. No new endpoints are registered for it, and the catalog shows the registered service.
- **RT-15** Anonymous buyers are allowed: x402 and MPP buyers need no account. Rate limits: per payment key, per IP for anonymous probes, and per target host.
- **RT-16** Never send `Authorization` to a target. It carries the payment key or MPP credentials. Routed requests use the proxy's request allowlist ([PX-5](proxy.md)), plus custom `X-…` headers, so a buyer's own key for the target, such as `X-Api-Key`, reaches it ([AR15](README.md#8-open-questions)).
- **RT-17** Routed `402`s carry no Bazaar metadata ([AR7](README.md#8-open-questions)).
- **RT-18** Hosts with bad success rates or abuse reports go on the blocklist through the internal API. The proxy refuses them.
- **RT-19** The link checker's endpoint, `GET /_/check?url=<link>`, runs RT-1 to RT-5 without paying. It returns whether the link is payable, the target's price and asset, our quote, and the routing link. It's rate limited per IP.

## As built in step 12

- **Targets:**
  - x402 `exact` on Base, from the v2 `PAYMENT-REQUIRED` header or the v1 body. Prices are rounded up to the micro-USD.
  - Solana and Tempo targets, and MPP challenges, come later: the Signer has no wallet there yet.
  - The paid retry carries `PAYMENT-SIGNATURE` (v2) or `X-PAYMENT` (v1).
- **Our hosts (RT-2)** are the registrable domains of `urls` and every subdomain, plus `ownHosts`. Sellers' hosts come from `services.hosts`, for services in any state. The opt-out file is fetched with a 2 s limit and cached a day under `optout:`.
- **Quotes** are cached 30 s under `quote:<method> <url>`. A retry's `402` drops the cached quote.
- **The ledger:**
  - The target leg is recorded in `target_payments` before the retry. Capture and settle of a routed payment read it: buyer held (or the buyer asset's treasury) → the target asset's treasury at the target price, plus `platform:routing_fees`.
  - A target that answers a failure but sends a successful `PAYMENT-RESPONSE` is booked as a routing loss: `platform:routing_losses` → the target asset's treasury.
- **Answers:** a failed call's `4xx` passes through uncharged, and `5xx` is the opaque `503`. The target's payment headers are dropped, and `Location` and links to the target's own origin point at the routing link.
- **Registration (RT-12):** a bounded queue in each proxy calls `PUT /internal/v1/routed-endpoints` (`INTERNAL_API_URL`, `INTERNAL_API_SECRET`). The API stores the host as the link names it, with a port when one was given.
- **Rate limits (RT-15):** the per-service limit counts per target host (`host:<host>`). `/_/check` uses the per-IP unpaid limit.
