# Ownership verification

Status: **draft**. Part of the [architecture overview](README.md).

Proves that a seller controls each upstream host before the service goes live. This stops sellers from reselling APIs they don't own. Apple and Google link apps to websites the same way: only the domain owner can publish a file on the domain.

| | |
|---|---|
| Packages | `core` (file parser, state machine), `api` (endpoints), `workers` (daily job) |
| Owns | `verification_tokens` (one per account), `payout_confirmations` (one per waiting revision), `upstream_hosts` (state per host) |
| Depends on | [Outbound HTTP](outbound-http.md), [Service registry](service-registry.md), [Accounts and keys](accounts-and-keys.md) (notices) |
| [Build step](README.md#7-build-order) | 8 |

## The file

The seller publishes it at `https://<upstream-host>/.well-known/servicerouter.json`:

```json
{
  "version": 1,
  "verification": ["sr-verify=6f1c0a9e2b...", "sr-confirm=93b7d14c0f..."],
  "services": [
    { "id": "weather-pro", "url": "https://pay.servicerouter.ai/service/weather-pro" }
  ],
  "routing": false
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | Yes | `1`. |
| `verification` | Yes | A list of tokens. `sr-verify=` verifies the host for an account. Several accounts can verify the same host, such as team members or staging. `sr-confirm=` confirms a payout change (OV-10). |
| `services` | No | Tells agents that visit the seller's domain where to call the API through the platform. |
| `routing` | No | `false` blocks [payment routing](payment-routing.md) to this host. |

The seller adds nothing to the service config. The tokens, the verification state, and any waiting payout change appear in the service status.

## Requirements

- **OV-1** One token per account: `sr-verify=<random>`. It isn't a secret: only the host's owner can publish it on that host.
- **OV-2** Fetch the file through Outbound HTTP, with `sameHost` redirects, the private-IP block, and a small size limit. Parse `version: 1`. The host passes when `verification` contains the account's token.
- **OV-3** Each upstream host is verified on its own. Verifying `api.example.com` doesn't verify `example.com` or other subdomains.
- **OV-4** State per host: `unverified` → `verified` → `missing` → `suspended`, and back to `verified` when the token returns. `missing` starts a 7-day grace period. After it, the host is `suspended`. All timing reads the `Clock` port.
- **OV-5** A host state change updates every service that uses the host ([SR-8](service-registry.md)) and reaches the proxy through the invalidation channel. A service goes live only when every host is verified.
- **OV-6** `POST /v1/services/{id}/verify` checks at once. A daily job re-checks every host of every live or suspended service, and every waiting payout confirmation, spread over the day.
- **OV-7** A notice to the seller is a status field and a log line. After the MVP, it's also an email when the account has a confirmed email ([AK-13](accounts-and-keys.md)).
- **OV-8** The same parser serves payment routing's opt-out check ([RT-2](payment-routing.md)).
- **OV-10** Payout confirmation. A stolen master key must not redirect earnings. An activation that changes `payouts` waits for the host owner ([SR-13](service-registry.md)):
  1. The submit or rollback response returns a confirmation token, `sr-confirm=<random>`, bound to the service and the new `payouts`.
  2. The seller adds the token to `verification` in the file on every upstream host.
  3. `POST /v1/services/{id}/verify` checks at once. When every host lists the token, the revision activates. Until then, the active revision keeps serving.
  4. The token expires after 7 days, and the waiting revision is dropped.
  5. A newer submit replaces the waiting revision. With the same `payouts`, it keeps the token. With other new `payouts`, it gets a new token. With the active revision's `payouts`, it activates at once.
  6. Once the revision is active, the seller can remove the token from the file.

  After the MVP, the confirmed email gets a notice when a payout change starts waiting and when it applies ([AK-13](accounts-and-keys.md)). A service's first activation needs no confirmation: verifying its hosts covers it.
