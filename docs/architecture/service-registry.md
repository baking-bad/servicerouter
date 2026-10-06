# Service registry

Status: **draft**. Part of the [architecture overview](README.md).

Accepts seller configs, keeps their revisions, and compiles the runtime the proxy serves.

| | |
|---|---|
| Packages | `core` (schema, checks, compiler), `db` (repositories), `api` (endpoints) |
| Owns | `services`, `service_revisions` with OpenAPI snapshots, the active revision pointer, service state |
| Depends on | [Common kit](common-kit.md) (strict YAML loader), [Outbound HTTP](outbound-http.md), [Platform config](platform-config.md), [Ownership verification](ownership-verification.md) (host states, payout confirmations), [Secrets](secrets.md) (secrets sent with a submit) |
| [Build step](README.md#7-build-order) | 2 |

## Config format

The seller submits one config per service, as YAML or JSON. Secrets go in the same request, outside the config (SR-12). Nothing in the config is about payment protocols or wallets. Format version `1`:

```yaml
servicerouter:                          # Platform-specific fields
  version: "1"                          # Config format version

service:                                # About the service, not the API
  id: my-app                            # Required. Unique, immutable, [a-z0-9-]. Used in the URL
  title: My App                         # Required. Up to 60 chars
  summary: Weather forecasts for any city   # Optional. One line, up to 120 chars
  description: |                        # Required. For agents and humans
    Current weather and 14-day forecasts for any city.
  category: weather                     # Required. One ID from the platform list
  tags: [forecast, geo]                 # Optional. Free-form search keywords
  links:
    homepage: https://example.com
    docs: https://example.com/docs
  contact:
    name: Your Name
    url: https://example.com/support
    email: support@example.com

payouts:                                # Where the seller gets paid
  default:                              # Required
    asset: cardano-usdm                 # From the asset registry
    address: addr1qx...

payments:                               # What a call costs, in USD
  default:                              # Required. Applies to every route
    amount: "0.001"
  premium:                              # Named. Missing fields come from `default`
    amount: "0.01"

upstreams:
  - baseUrl: https://api.example.com    # Required. HTTPS, public host. May include a path prefix. Trailing slash ignored
    name: main                          # Optional. [a-z0-9-]. For errors, metrics, route keys
    type: http                          # Optional. Default and only v1 value: http
    openapi: https://api.example.com/openapi.json   # Either a link...
    auth: main-key                      # Credential name

  - baseUrl: https://files.example.com
    name: files
    paths:                              # ...or an inline OpenAPI `paths` object
      /upload:
        post:
          operationId: uploadFile
          summary: Upload a file
    auth: [files-key, files-app]        # A list: all credentials are sent

routes:                                 # Optional. Key: operationId, or <upstream>/<operationId> if ambiguous
  getWeather:
    payment: premium                    # Named payment
  getForecast:
    target:                             # Where to forward. Default: the same path
      path: /internal/forecast/{city}
  files/uploadFile:
    payment:                            # Inline payment
      amount: "0.01"
  adminReset:
    enabled: false                      # Not exposed: 404

credentials:                            # How the platform authenticates to upstreams. No default
  main-key:
    type: http
    scheme: bearer                      # bearer → Authorization: Bearer <secret>. basic → the secret is user:password
    secret: weather-key                 # A secret name. The value is never inline (SR-12)
  files-key:
    type: apiKey
    in: header                          # header | query | cookie
    name: X-Api-Key                     # → X-Api-Key: <secret>
    secret: files-key
  files-app:
    type: apiKey
    in: header
    name: X-App-Id
    secret: files-app-id
```

**Price merge order:** `payments.default`, then the route's `payment` (named or inline). Each layer overrides only the fields it sets. Objects merge by key. Values and lists replace.

**Path templates:** a path segment holds at most one `{parameter}`, alone or with literal text around it, such as `/files/{id}.json` or `/jobs/{job}:cancel`. Two parameters in one segment, or a parameter name used twice, fail at compile (SR-2, pass 3).

**Reserved for later**, rejected in v1: `rules` (CEL conditions on the request), upstream types `mcp`, `graphql`, `websocket`, `grpc`, `chargeOn`, and per-unit prices.

## Requirements

- **SR-1** Load YAML or JSON with the strict YAML loader ([CK-8](common-kit.md)).
- **SR-2** Validate in three passes and report every error at once, each with its path, line, and column:
  1. JSON Schema, with `additionalProperties: false` everywhere and strict patterns for amounts and names.
  2. Semantic checks:
     - route keys exist in the upstreams' operations;
     - upstream names are unique;
     - named payments that routes use exist;
     - referenced credentials exist. Warn about secrets that aren't set and aren't in the request;
     - the payout asset exists in the asset registry;
     - amounts are valid USD decimals with at most 6 fractional digits;
     - the category is in the platform list;
     - upstream base URLs are HTTPS on a public host;
     - paths don't conflict across upstreams.
  3. Compile (SR-5).
- **SR-3** Fetch linked OpenAPI documents at submit time through Outbound HTTP, with `sameHost` redirects and size and time limits. Store a snapshot in the revision. Store inline `paths` as they are. Never fetch a document while serving a call.
  - Links are fetched concurrently. A failure is an issue at the link that names the host and what went wrong, never anything from the response.
- **SR-4** Revisions are immutable and numbered per service. Keep the config as submitted, for the seller, and normalized, for compiling. A submit identical to the active revision is a no-op.
  - Identical means the same parsed config and the same OpenAPI documents, compared as canonical JSON. Formatting, comments, key order, and the media type don't count. A changed OpenAPI document makes a new revision.
  - Revision numbers are assigned under a row lock on the service, so concurrent submits get consecutive numbers.
- **SR-5** Compiling is a pure function of the revision and platform config. It returns a deeply frozen `ServiceRuntime`:
  - state;
  - an operation matcher;
  - per operation: the upstream, the `target` path, the price in micro-USD, the `enabled` flag, credential references, and doc metadata ([AD-3](agent-docs.md)).

  It reads no secret values and does no I/O.
  - Each operation has its route key (SR-6, in its short form when the operationId is unique), method and path template, upstream (name, base URL, origin, path prefix), target template, price, `enabled`, credential references (the credential, how to apply it, and the secret's name), and doc metadata.
  - `runtime.match` walks a trie per method, built at compile time. `targetPath` builds the upstream path, keeping params percent-encoded.
  - Template literals are stored percent-encoded in one normalized form, `normalizePathText`. The proxy normalizes request segments with the same function.
- **SR-6** Route keys are `operationId`, or `<upstream>/<operationId>` when two upstreams share an `operationId`. A key splits on the first `/` only. Upstream names are `[a-z0-9-]`, so they never clash.
- **SR-7** Activation moves the pointer and publishes the service ID on the Redis invalidation channel. Rollback activates an earlier revision the same way.
  - `POST /v1/services/{id}/rollback` with `{ "revision": n }` takes any stored revision, so it also rolls forward. The active one answers `changed: false`. An unknown one is `404 not_found`.
  - The event is published after the commit, with a 2 s deadline. A failure is logged, and the request still succeeds: caches expire on their own.
- **SR-8** Service state: `pending` until every upstream host is verified, then `live`. `suspended` while any host is suspended ([Ownership verification](ownership-verification.md)). The proxy serves only `live` services.
  - The `OwnershipStatus` port answers whether every upstream host of a service is verified. Until step 8, its adapter `assumeHostsVerified` says yes, so an activation is `live` (S2-D1).
- **SR-9** Reserved fields fail validation with a clear "not supported yet" error. They are never silently ignored.
- **SR-10** Price changes apply to new requests at once, unless the revision also changes `payouts` (SR-13).
- **SR-11** Every submit, activation, and rollback writes the audit log.
  - `service.submit` `{ revision, changed }`, `service.activate` `{ revision, previousRevision, state, payoutsChanged }`, and `service.rollback` `{ revision, previousRevision, changed }`. The actor is the account, the subject the service, and every entry carries the request ID.
- **SR-12** `PUT /v1/services/{id}` takes the config alone, as YAML or JSON, or a JSON envelope with its secrets:

  ```json
  {
    "config": "servicerouter:\n  version: \"1\"\n…",
    "secrets": { "weather-key": "…", "files-key": "…", "old-key": null }
  }
  ```

  - A JSON body with a top-level `config` field is an envelope. `config` is the config as a YAML string or a JSON object.
  - `secrets` maps secret names to values. Omitted names keep their values. `null` deletes one. [SC-9](secrets.md) covers how they're handled.
  - Secrets are written even when the config is a no-op (SR-4).
  - Media types: `application/json` (the config, or the envelope), and `application/yaml`, `application/x-yaml`, or `text/yaml`. The body may be up to 2 MiB; the config itself up to 1 MiB ([CK-8](common-kit.md)). The envelope takes only `config` and `secrets`.
  - Responses: `201` when the submit created the service, `200` otherwise, with `{ id, revision, changed, state, warnings }`. A service owned by another account is `403 forbidden` on every endpoint.
  - Config errors are `400 invalid_config`: `{ "error": { "code", "message", "details": [{ "path", "line", "column", "message" }], "warnings": [...] } }`. `line` and `column` are `null` when a problem has no position. Positions come for YAML, JSON, an envelope's YAML string, and an envelope's config object.
- **SR-13** An activation that changes `payouts`, including a rollback, waits for a payout confirmation ([OV-10](ownership-verification.md)). Until then, the active revision keeps serving. The service's first activation needs no confirmation. Ownership verification arrives in step 8. Until then, payout changes activate at once.

## Storage

- `services`: the ID, the owning account, the state, and the active revision, a foreign key to `service_revisions`.
- `service_revisions`: unique by service and number. The config as submitted with its media type, the parsed config, and the OpenAPI snapshots by link, as `json` so key order survives. No update or delete.
- `service_secrets`: owned by [Secrets](secrets.md).
- For the proxy, `loadForServing(id)` returns a `ServingService` read in one snapshot: the state, the active revision, the parsed config, the OpenAPI snapshots, and the sealed secrets.
