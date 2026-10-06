# Payment rails

Status: **draft**. Part of the [architecture overview](README.md).

Credits, x402, and MPP behind one interface. Used for registered services and for the buyer side of routed calls.

| | |
|---|---|
| Packages | `payments` (rails, combined `402`, credential detection), `core` (asset registry). Adapters in `proxy` and `db`. |
| Owns | No tables. It writes through ports. |
| Depends on | [Ledger](ledger.md) (`CreditsLedger`, `PaymentRecorder`), [Accounts and keys](accounts-and-keys.md) (`KeyStore`), Redis (`ReplayStore`), the CDP facilitator, the [Cardano facilitator](cardano-facilitator.md) |
| [Build step](README.md#7-build-order) | 4 (credits), 5 (x402 on Base and Solana), 6 (x402 on Cardano), 7 (MPP) |

**Terms.** x402 is an open payment protocol built on HTTP `402 Payment Required`. It settles stablecoins on networks such as Base, Solana, and Cardano, through a facilitator that verifies and settles payments. MPP (Machine Payments Protocol, by Stripe and Tempo) is another 402-based protocol, with stablecoins, cards, and sessions. Credits are a prepaid balance on the platform: no on-chain fee per call, so sub-cent prices work.

## Interface

```ts
interface PaymentRail {
  readonly name: RailName;
  readonly settlesBeforeResponse: boolean;               // x402: buffer, settle, then send (PX-12)
  detect(headers: RequestHeaders): Credential | undefined;
  challenge(quote: Quote): Promise<ChallengePart | undefined>; // Headers and JSON body fields for the 402
  authorize(credential: Credential, quote: Quote): Promise<Authorization>;
  finalize(authorization: Authorization): Promise<Receipt>;
  abort(authorization: Authorization): Promise<void>;
}

interface Quote {
  readonly paymentId: string;
  readonly requestId: string | undefined;
  readonly resource: string;           // Canonical pay URL (PX-10)
  readonly priceMicroUsd: bigint;
  readonly description: string;
  readonly subject: PaymentSubject;    // A service with its seller and route, or a routed target (LG-7)
  readonly feeBps: number;             // Taken at capture or settlement (LG-4)
  readonly discovery?: BazaarMetadata; // Registered services only (AD-3)
}

interface Authorization {
  readonly rail: RailName;
  readonly paymentId: string;
  readonly amount: bigint;
  readonly feeBps: number;
  readonly buyer: string;              // For the buyer header (PX-15): `account:<id>`, or the payer
  readonly receipt: Receipt | undefined; // Known before finalizing: credits, whose responses stream
}
```

Detection runs a detector for every kind of credential, served or not, so two of any kind get `400`. A credits credential carries only the key's hash. A rail that isn't served yet gets the combined `402`.

## Requirements

- **PR-1** A request carries exactly one credential:

| Credential | Rail |
|---|---|
| `Authorization: Bearer <payment key>`, such as `sr_live_…` ([PC-7](platform-config.md)) | Credits |
| `Authorization: Payment …` | MPP |
| `PAYMENT-SIGNATURE` (x402 v2), and `X-PAYMENT` (v1) if the SDK accepts it | x402 |

  None → the combined `402`. Two or more → `400 multiple_payment_methods`. A master key → `401 wrong_key_type` ([AK-4](accounts-and-keys.md)).
  - Any `Authorization: Bearer` counts as a credits credential. One that isn't a well-formed payment key gets `401 invalid_key`.
  - `PAYMENT-SIGNATURE` and `X-PAYMENT` together are one x402 credential. The header stays in a `Secret` until the rail decodes it.
  - x402 v1 (`X-PAYMENT` alone) gets `402 payment_invalid`: the SDK's v2 resource server reads only `PAYMENT-SIGNATURE`.
- **PR-2** The combined `402` is one response, assembled from each rail's `challenge()`:
  - `PAYMENT-REQUIRED` (x402): one `accepts` entry per enabled asset. At launch: USDC on Base, USDC on Solana, USDM on Cardano, all scheme `exact`. Amounts are converted from USD with the asset registry ([PC-6](platform-config.md)).
  - `WWW-Authenticate: Payment` (MPP): the Tempo charge.
  - A JSON body: the x402 body, plus a `credits` object with the USD price, the signup endpoint (`POST https://api.servicerouter.ai/v1/accounts`), and the onboarding guide (`https://servicerouter.ai/llms.txt`).
    - `credits` is `{ price, currency: "USD", authorization: "Bearer <payment key>", signup: { method, url }, guide }`, with the URLs from platform config.
  - `Cache-Control: no-store`.

  The agent retries with exactly one of them.
- **PR-3** Skip an asset whose minimum price is above the call price.
- **PR-4** Credits:
  1. Authenticate the key: a hash lookup, cached briefly.
  2. Check the key's expiry and limits: maximum price per call, daily budget, and allowance ([AK-6](accounts-and-keys.md)).
  3. Place a hold through `CreditsLedger`. It checks the balance and the key's spend in one transaction ([LG-6](ledger.md)).
  4. After the response: capture if billable, release otherwise.
  5. Return the receipt header with the payment ID and the amount ([AR2](README.md#8-open-questions)).
- **PR-5** x402:
  1. Build payment requirements per request from the quote, with the SDK's resource-server primitives. There is no static route table. `payTo` is the platform's treasury address for the network.
  2. Verify through the facilitator before forwarding. A rejection → `402 payment_invalid`, and the upstream is never called.
  3. After a billable response, settle, then send the response with `PAYMENT-RESPONSE`. Otherwise cancel: nothing is settled.
- **PR-6** Facilitator registry, in platform config: name, URL, networks, auth reference.
  - Base and Solana go through Coinbase's CDP facilitator, with a CDP JWT per endpoint.
  - Cardano goes through the [Cardano facilitator](cardano-facilitator.md) service on the internal network. It takes no auth header.
  - Check every facilitator's `/supported` at startup, with a timeout. Fail fast.
  - A facilitator with `enabled: false` isn't checked, and its networks aren't offered. Cardano is off until step 6.
  - Our own client implements the SDK's `FacilitatorClient`, with a verify timeout (the connect timeout) and a settle timeout (`timeouts.settleMs`). The startup check gets 10 s.
  - The CDP JWT, one per request: `sub` the key ID, `iss: "cdp"`, `uris: ["<METHOD> <host><path>"]`, `iat`, `nbf`, `exp` 120 s later, with `kid` and a random `nonce` in the header. Ed25519 keys (base64 of 64 bytes) sign EdDSA. P-256 PEM keys sign ES256. Checked against live CDP.
  - On verify or settle, a `4xx` without a verify or settle answer refuses the payment, as CDP's `400` for a malformed one does. `401`, `403`, `408`, `429`, a `5xx`, a timeout, or a failed connection mean the facilitator is unavailable: `503 facilitator_unavailable` at verify, an unknown outcome at settle.
  - An EVM asset's EIP-712 domain comes from the SDK's default assets. An asset it doesn't know stops startup.
- **PR-7** x402 Bazaar: Coinbase lists services that settle through the CDP facilitator in its x402 Bazaar automatically. For registered services, the x402 challenge carries the discovery metadata from [AD-3](agent-docs.md), so each service is listed under its pay URL.
- **PR-8** The Cardano `accepts` entry sets `extra.confirmationPolicy.l1Confirmations` ([AR12](README.md#8-open-questions)). The transfer method is `default`.
- **PR-9** MPP: an `mppx` server with the Tempo charge intent. The recipient is the platform's Tempo address. The replay store is in Redis, shared by all replicas. Add the receipt (`Payment-Receipt`) to the response, with private cache control.
  - **Charged after a billable answer, like x402** (owner, 2026-10-06T19:50:00+08:00). The challenge offers pull mode only (`supportedModes: ["pull"]`): the client signs a Tempo transaction, and we broadcast it. Validate the credential before forwarding (`validateCredential`, which moves nothing), and broadcast it only after a billable response (`broadcastCredential`). Otherwise it is never broadcast, and the buyer pays nothing. A push credential, one the client already broadcast, gets `402 payment_invalid`.
  - The currencies are the asset registry's assets on the MPP network ([PC-6](platform-config.md)), at or above their minimum price (PR-3). The settled amount books the asset's treasury, as for x402.
  - The challenge's HMAC key is `MPP_SECRET_KEY`, at least 32 bytes, the same on every proxy replica.
  - The proxy never sponsors fees and holds no key that moves funds ([rule 6](README.md#2-architecture-rules)): the buyer's transaction pays its own fee.
  - Outcomes follow PR-12. Confirmed → booked, and the response goes out. Reverted or refused → `502 settlement_failed`, nothing booked. A timeout or a failed RPC call → unknown: the payment is `settling` with the transaction hash, which is known before the broadcast, and the settlement follow-up reads its receipt ([WK-6](workers.md)).
- **PR-10** Every authorize, finalize, and abort writes a `payments` status change through `PaymentRecorder`, keyed by payment ID.
- **PR-11** A rail doesn't know whether a call is registered or routed. Only the quote differs. `payments` imports nothing from Fastify or Drizzle. The MPP Fastify-to-Fetch adapter lives in `proxy`.
- **PR-12** Settle outcomes. The proxy calls `settle` with its own timeout (30 s by default).

| Facilitator answer | What we do |
|---|---|
| Settled | Send the response. Book the earnings. |
| Pending, with a transaction hash | The transaction was broadcast. Send the response. Record the payment as `settling` with the hash. A worker repeats the identical `settle` until it's final, then books the earnings. |
| Failed, or nothing submitted | Cancel. Don't send the response: `502 settlement_failed`. The buyer isn't charged. |
| Timeout or `503` | The outcome is unknown. Don't send the response: `502 settlement_failed`. Record the payment as `settling` without a hash. The worker repeats the identical `settle`. If it confirms, the payment is flagged for review: the buyer paid and got no response. |

  A broadcast that later fails is rare, and the amounts are small. Holding a response for minutes is worse.

  - "The buyer got no response" means no `PAYMENT-RESPONSE` was sent: a `settling` payment without a receipt. The follow-up flags it for review when it confirms.
  - The settle request is kept on the payment (`settlement_request`) while it's `settling`, so the worker repeats it exactly.
  - A non-billable or too-large answer cancels the payment: `verified` → `cancelled`.
