# Proxy

Status: **draft**. Part of the [architecture overview](README.md).

Serves `pay.servicerouter.ai`: registered services, routed calls, and platform paths.

| | |
|---|---|
| Package | `proxy` |
| Host | `pay.servicerouter.ai` |
| Owns | No tables. It writes payments through the Ledger. |
| Depends on | [Service registry](service-registry.md), [Secrets](secrets.md), [Accounts and keys](accounts-and-keys.md), [Payment rails](payment-rails.md), [Ledger](ledger.md), [Payment routing](payment-routing.md), [Outbound HTTP](outbound-http.md) |
| [Build step](README.md#7-build-order) | 3, payments in steps 4–7 |

## Modules

| Module | Does |
|---|---|
| Dispatcher | Reads the first path segment and picks a handler. |
| Runtime cache | Holds compiled service runtimes with their secrets. |
| Matcher | Finds the operation for a method and path. |
| Payment step | Runs the payment rails around the forward. |
| Forwarder | Calls the upstream and applies the header and response rules. |
| Limits | Rate limits in Redis. |
| Platform paths | `/_/health`, `/_/ready`, `/_/key` ([AK-8](accounts-and-keys.md)), the link checker, `/.well-known/`. |

## Requirements

- **PX-1** Dispatch on the first path segment:
  - `service` → a registered service: `/service/<service-id>/<path>`;
  - `_` or `.well-known` → platform paths;
  - a segment with a dot → [payment routing](payment-routing.md): `/<host>/<path>`. A hostname always has a dot, so it never clashes with the words above;
  - no segment → the link checker page;
  - anything else → `400 invalid_target`.
- **PX-2** Forward, never redirect. The proxy calls the upstream or target itself and returns its response. With a redirect, the agent would pay the target directly. Clients also drop `Authorization` on cross-origin redirects, which breaks payment keys and MPP.
- **PX-3** Runtime cache: an in-process LRU by service ID. On a miss, load the active revision and its secrets, compile, and cache. Invalidate on the Redis channel. Keep a TTL as a safety net. Cache unknown IDs briefly, so random IDs don't reach Postgres.
- **PX-4** Match the method and the rest of the path against the runtime's operations. Literal segments beat parameters. No match, `enabled: false`, or a `pending` service → `404`. A `suspended` service → `403 service_suspended`.
  - Each request segment is normalized with `normalizePathText` before matching ([SR-5](service-registry.md)).
  - Literal beats parameter segment by segment. A parameter route still matches when a literal branch leads nowhere further on.
- **PX-5** The request to the upstream:
  - Method, path (after `target` rewriting), query, and body pass through.
  - Only these request headers pass: `accept`, `accept-encoding`, `accept-language`, `cache-control`, `content-digest`, `content-encoding`, `content-language`, `content-length`, `content-type`, `digest`, `idempotency-key`, `if-match`, `if-modified-since`, `if-none-match`, `if-range`, `if-unmodified-since`, `prefer`, `range`, `repr-digest`, `want-content-digest`, `want-digest`, `want-repr-digest`. Everything else is dropped, including `Authorization`, `PAYMENT-SIGNATURE`, `X-PAYMENT`, and `Cookie`.
  - Add `x-request-id` and the buyer header (PX-15).
  - Apply the seller's credentials after filtering: bearer or basic `Authorization`, or an API key in a header, the query, or a cookie.
- **PX-6** The response to the client:
  - Only these response headers pass: `accept-ranges`, `age`, `allow`, `cache-control`, `content-digest`, `content-disposition`, `content-encoding`, `content-language`, `content-length`, `content-range`, `content-type`, `deprecation`, `digest`, `etag`, `expires`, `last-modified`, `preference-applied`, `ratelimit`, `ratelimit-policy`, `repr-digest`, `retry-after`, `sunset`, `vary`, `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, plus `location`, `content-location`, and `link`. `Set-Cookie` never passes: all services share one origin.
  - Redirects pass through to the client. `Location`, `Content-Location`, and `Link` that point at the upstream are rewritten to `https://pay.servicerouter.ai/service/<service-id>/…`. Response bodies are not rewritten.
  - Add `x-request-id` and the payment receipt headers.
- **PX-7** Upstream failures: transport errors, timeouts, and statuses the operation doesn't declare (unless it declares `default`) return one opaque `503 upstream_unavailable` with only `x-request-id`. No upstream detail leaks. The buyer isn't charged.
- **PX-8** Limits: request body 1 MiB, connect timeout 5 s, total timeout 30 s. Automatic HEAD routes are off, so a paid GET can't be reached for free.
- **PX-9** Add `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` to every proxied response. Seller and target responses share the `pay.servicerouter.ai` origin with the link checker. A seller's HTML must not run as that origin.
- **PX-10** Build the x402 `resource` and every self-link from the canonical URL in platform config. Never from the request's `Host` header.
- **PX-11** Billable means `2xx`, until the config adds `chargeOn`. Record the decision on the payment row before finalizing ([rule 5](README.md#2-architecture-rules)).
  - An operation priced at `"0"` is free: no payment step, and any credential on it is dropped (PX-5).
  - A failed decision write is logged, and finalizing goes on. Without a recorded decision, the hold expiry worker releases, so a buyer is never charged by mistake. The opaque `503` records `not_billable` and releases before answering.
- **PX-12** Credits responses stream. x402 and MPP responses are buffered until the settlement is confirmed or broadcast ([PR-12](payment-rails.md), [PR-9](payment-rails.md)), so no upstream bytes reach an unpaid client. Above the buffer limit ([AR3](README.md#8-open-questions)), cancel and return `502 response_too_large`. The buyer isn't charged.
  - The upstream's status and headers go out only with the settled response, never with the `502`.
  - A body that fails before anyone reads it, while the decision is recorded, must not crash the process: the proxy listens for its error at once.
- **PX-13** Rate limits in Redis: per payment key, per service, and per IP for unpaid requests that only get a `402`. Over a limit → `429` with `Retry-After`. Limits are keyed by service ID, not by hostname.
  - Fixed windows under `rl:proxy:paymentKey:<key hash>`, `rl:proxy:service:<id>`, and `rl:proxy:unpaidIp:<client>`, from `rateLimits` in platform config. The key limit counts before any lookup. The service limit counts paid attempts only, so unpaid floods can't use it up. An IPv6 client counts by its /64.
  - While Redis fails, a limit lets the request through, logged and counted. The Ledger still guards the money.
  - Behind Traefik, `TRUST_PROXY` must name it, or every client counts as Traefik's address.
- **PX-14** While a buyer waits, the proxy calls only Postgres, Redis, facilitators, the Signer, and upstreams or targets ([rule 1](README.md#2-architecture-rules)).
- **PX-15** The buyer header, `Servicerouter-Buyer`, tells the upstream which buyer is calling without exposing who it is. Its value is an HMAC-SHA256, under a platform key, of the buyer and the service ID, in base64url. The buyer is the credits account, or the payer address for x402 and MPP. The value is stable per buyer and service, and differs across services.
  - The input is `<buyer>\n<service ID>`, with the buyer as `account:<id>` for credits. The key is `BUYER_HEADER_KEY`, at least 32 characters, the same on every replica. Rotating it gives every buyer a new value.
- **PX-16** CORS: expose `PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`, `WWW-Authenticate`, `Payment-Receipt`, the credits receipt header, and `x-request-id`. Allow the `Authorization`, `PAYMENT-SIGNATURE`, `X-PAYMENT`, and `Content-Type` request headers.
- **PX-17** `/_/health` for liveness. `/_/ready` checks Postgres, Redis, and every facilitator's `/supported`. Metrics on an internal port.
  - One check per enabled facilitator, named `facilitator:<name>`.
- **PX-18** Shutdown: stop accepting, drain in-flight requests, finish or release their holds, close pools. A credits payment is finished when its response closes, and shutdown waits for every finish in flight.
- **PX-19** Credits overhead stays under 50 ms p95.
  - Checked by `npm run loadtest` at 300 paid requests per second per replica ([AR20](README.md#8-open-questions)), sent at a fixed rate, against the free path at the same rate. It also reports each path's capacity, without a pass or fail: past it, latency is queueing.
  - Step 4 measured 4.5 to 27 ms. One replica handled about 700 paid calls per second on a laptop, bound by its own CPU, mostly building SQL. Hand-written SQL for the hot statements, or LG-11, would raise it.

## Error codes

Every `401` carries `WWW-Authenticate: Bearer`, and every `402` carries `Cache-Control: no-store`.

| Status | Code | When |
|---|---|---|
| `400` | `invalid_request` | A malformed request, such as invalid JSON. Answered by the server itself ([CK-10](common-kit.md)). |
| `400` | `invalid_target` | The first segment isn't `service`, a platform path, or a hostname. Or the host is an IP address. |
| `400` | `multiple_payment_methods` | Two or more payment credentials. |
| `400` | `not_payable` | Routing: the target didn't answer `402`. |
| `400` | `host_not_allowed` | Routing: our host, a blocklisted host, or an opted-out host. |
| `401` | `unauthorized` | `GET /_/key` without a payment key. |
| `401` | `invalid_key` | Unknown, revoked, or expired payment key. |
| `401` | `wrong_key_type` | A master key. Paid calls take a payment key ([AK-4](accounts-and-keys.md)). |
| `402` | none | No credential. The combined challenge. |
| `402` | `insufficient_balance` | Credits don't cover the price. |
| `402` | `key_budget_exceeded` | The key's daily budget is used up. |
| `402` | `key_allowance_exceeded` | The key's allowance is used up. |
| `402` | `key_price_limit` | The price is above the key's per-call maximum. |
| `402` | `payment_invalid` | A facilitator rejected the x402 payment (the message names its reason), the payment doesn't match an option for the price, it isn't x402 v2, or MPP verification failed. |
| `403` | `service_suspended` | The service is suspended. |
| `404` | `not_found` | Unknown service or operation, or a disabled route. |
| `413` | `request_too_large` | The request body is over the limit (PX-8). |
| `415` | `unsupported_media_type` | A content type the route doesn't take. |
| `429` | `rate_limited` | Over a rate limit. |
| `500` | `internal_error` | Anything unexpected. Opaque: the details go to the log only (XC-7). |
| `502` | `unsupported_payment` | Routing: no option we can pay. |
| `502` | `quote_exceeded` | Routing: the target asked for more than the quote. |
| `502` | `response_too_large` | x402: the response is over the buffer limit. |
| `502` | `settlement_failed` | x402: settlement failed or its outcome is unknown. No response bytes were sent. |
| `503` | `upstream_unavailable` | The opaque upstream failure. Also used when the Signer refuses. |
| `503` | `facilitator_unavailable` | A facilitator didn't answer an x402 verify. Nothing was paid. |
