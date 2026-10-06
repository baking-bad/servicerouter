# Ownership verification

Status: **draft**. Part of the [architecture overview](README.md).

Proves that a seller controls each upstream host before the service goes live. This stops sellers from reselling APIs they don't own. Apple and Google link apps to websites the same way: only the domain owner can publish a file on the domain.

| | |
|---|---|
| Packages | `core` (file parser, state machine), `api` (endpoints), `workers` (daily job) |
| Owns | `verification_tokens` (one per account), `payout_confirmations` (one per waiting revision), `upstream_hosts` (state per account and host) |
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
  - Limits: 64 KiB, connect 5 s, total 10 s (`ownershipFileLimits`). The file is JSON. Unknown fields are ignored, so a later version can add some.
  - A failed check records its problem: `file_not_found` (404 or 410), `fetch_failed` (any other status, a refused address or redirect, a timeout, an oversized file), `invalid_file`, or `token_missing`. Reasons name the host, never anything from the response.
- **OV-3** Each upstream host is verified on its own. Verifying `api.example.com` doesn't verify `example.com` or other subdomains.
- **OV-4** State per host: `unverified` → `verified` → `missing` → `suspended`, and back to `verified` when the token returns. `missing` starts a 7-day grace period. After it, the host is `suspended`. All timing reads the `Clock` port.
  - The state is per account and host: several accounts can verify the same host, and one account's token doesn't verify it for another.
  - A failed fetch counts as a missing token. A `missing` host is suspended by the first check at or after the end of its grace period that still doesn't find the token.
- **OV-5** A host state change updates every service that uses the host ([SR-8](service-registry.md)) and reaches the proxy through the invalidation channel. A service goes live only when every host is verified.
  - A service is `suspended` while any host is, `live` while every host is `verified` or `missing`, and `pending` otherwise.
  - `services.hosts` holds the active revision's hosts, written at activation, so a check finds the account's services that use a host. Every check recomputes their states, changed or not. Each change is audited (`service.state`) and published after the commit.
- **OV-6** `POST /v1/services/{id}/verify` checks at once. A daily job re-checks every host of every live or suspended service, and every waiting payout confirmation, spread over the day.
  - `verify` fetches each host of the active and the waiting revision once, and answers with the status. `GET /v1/services/{id}/status` shows the state, the account's token, each host's state, last check, problem, and `suspendsAt`, the waiting payout change with the hosts that list its token, and the notices.
  - Each host has its next check time, 24 hours after its last check, or the end of its grace period if that comes first. The job runs every 5 minutes and checks at most 50 due hosts and 50 due payout changes per run, oldest first. A pending service isn't re-checked: its seller calls `verify`.
- **OV-7** A notice to the seller is a status field and a log line. After the MVP, it's also an email when the account has a confirmed email ([AK-13](accounts-and-keys.md)).
  - Status notices: `host_unverified`, `host_missing` (with when it is suspended), `host_suspended`, and `payout_change_waiting`. Log lines carry `notice: true` for each host and service state change and each payout change that applies or expires.
- **OV-8** The same parser serves payment routing's opt-out check ([RT-2](payment-routing.md)).
- **OV-9** Staging only: an internal action marks a host verified, for demos with sellers who haven't published the file yet. Production config can't enable it.
- **OV-10** Payout confirmation. A stolen master key must not redirect earnings. An activation that changes `payouts` waits for the host owner ([SR-13](service-registry.md)):
  1. The submit or rollback response returns a confirmation token, `sr-confirm=<random>`, bound to the service and the new `payouts`.
  2. The seller adds the token to `verification` in the file on every upstream host.
  3. `POST /v1/services/{id}/verify` checks at once. When every host lists the token, the revision activates. Until then, the active revision keeps serving.
  4. The token expires after 7 days, and the waiting revision is dropped.
  5. A newer submit replaces the waiting revision. With the same `payouts`, it keeps the token. With other new `payouts`, it gets a new token. With the active revision's `payouts`, it activates at once.
  6. Once the revision is active, the seller can remove the token from the file.

  As built in step 8: the submit or rollback answers with `payoutConfirmation: { revision, token, expiresAt }`, and its `revision` and `state` stay the active ones. A submit identical to the waiting revision stores nothing new and answers the same. A submit identical to the active revision drops the waiting one. A rollback that changes `payouts` waits the same way. A waiting change may not move a secret the active revision uses to another host (`409 secret_origin_mismatch`), so the active revision keeps serving. Audit: `service.payout_change_wait`, `…_confirm`, `…_drop`, `…_expire`.

  After the MVP, the confirmed email gets a notice when a payout change starts waiting and when it applies ([AK-13](accounts-and-keys.md)). A service's first activation needs no confirmation: verifying its hosts covers it.
