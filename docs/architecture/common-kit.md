# Common kit

Status: **draft**. Part of the [architecture overview](README.md).

Shared building blocks with no domain logic.

| | |
|---|---|
| Package | `common` |
| Owns | No data |
| Used by | Every package |
| [Build step](README.md#7-build-order) | 1 |

## Requirements

- **CK-1** `Secret` wraps every credential: seller upstream secrets, treasury and Signer keys, the CDP key, the Blockfrost key, the secrets key pair, the SMTP password, shared secrets.
  - `toString`, `toJSON`, and `util.inspect` return a redaction marker.
  - `equals` is timing-safe.
  - `destroy()` zeroes the buffer. Any use after it throws.
  - The value comes out only through an explicit `expose()`.
- **CK-2** Errors are named classes with a stable snake_case `code`, such as `multiple_payment_methods`. `toJSON` leaves out the stack. Each app maps codes to HTTP statuses in one table. Codes are part of the API: never rename one.
- **CK-3** The logger is pino, writing JSON to stdout. It redacts these request and response headers: `authorization`, `payment-signature`, `x-payment`, `payment-receipt`, `payment-required`, `payment-response`, `www-authenticate`, `cookie`, `set-cookie`. Never log bodies, upstream request headers, or the URL of a route that puts a key in the query.
- **CK-4** Money:
  - The unit is integer micro-USD as `bigint`: 1 USD = 1,000,000. Postgres `bigint`, Drizzle `bigint({ mode: 'bigint' })`.
  - Parse decimal strings with a strict pattern. Reject more than 6 fractional digits, exponents, signs where they aren't allowed, and values that overflow.
  - Never use floats.
  - Convert to an asset's atomic units with exact integer math, using the decimals from the asset registry.
  - A conversion that isn't exact takes an explicit rounding mode from the caller. There is no default rounding.
- **CK-5** Ports: `Clock` and `IdGenerator`. Domain code never calls `Date.now()` or makes random IDs itself.
- **CK-6** Process lifecycle: on `SIGINT` or `SIGTERM`, stop accepting work, run the app's shutdown hooks, and exit. Force the exit after a timeout (30 s by default). Log and shut down on an uncaught exception or an unhandled rejection.
- **CK-7** A timeout helper wraps any promise with a deadline and an `AbortSignal`.
- **CK-8** The strict YAML loader, used for seller configs and platform config:
  - YAML 1.2 core schema;
  - unique keys;
  - no custom tags and no merge keys;
  - at most 50 aliases;
  - a 1 MiB size limit;
  - fatal UTF-8 decoding: invalid bytes are an error;
  - nesting depth at most 64, and no cycles;
  - keys named `__proto__`, `prototype`, or `constructor` are rejected.
- **CK-9** Shared types: request ID, service ID, asset name, network ID (CAIP-2, such as `eip155:8453` or `cardano:mainnet`).
- **CK-10** The HTTP server every app runs, on Fastify 5 (`createServer`, `runApp`):
  - the request ID (XC-5), on the response and on every log line of the request;
  - one log line per request with the method, route pattern, status, sizes, and latency, never the URL, headers, or body (XC-7, CK-3);
  - errors as `{ "error": { "code", "message" } }` with statuses from the app's one table (CK-2). A code missing from the table, and any other error, answer an opaque `500 internal_error`, logged with its stack. Unknown routes are `404 not_found`. Fastify's own request errors are `400 invalid_request`, `413 request_too_large`, or `415 unsupported_media_type`;
  - no automatic HEAD routes (PX-8);
  - `/_/health` and `/_/ready` (XC-3), and a metrics listener on a port of its own (XC-2);
  - an app that can't start, such as with an invalid platform config (PC-1), logs why and exits with 1. SIGINT and SIGTERM stop accepting, drain in-flight requests, close the app's connections, and exit (CK-6).
