# Accounts and keys

Status: **draft**. Part of the [architecture overview](README.md).

Accounts, their master and payment keys, and account recovery by email.

| | |
|---|---|
| Packages | `core`, `db`, `api`, `web` (email pages) |
| Owns | `accounts`, `api_keys` with limits, `email_links` |
| Depends on | [Platform config](platform-config.md) (key prefixes, default limits, SMTP relay), [Deposits](deposits.md) (deposit address at signup), [Website](website-and-link-checker.md) (email pages) |
| [Build step](README.md#7-build-order) | 2 (accounts, master keys), 4 (payment keys). Email and recovery (AK-10 to AK-14) come after the MVP ([AR19](README.md#8-open-questions)) |

**Terms.** One API call creates an account, so an agent can sign up without a person or a UI. The same account can sell (own services) and buy (hold credits). Its master key manages it. Its payment keys pay for calls with credits. x402 and MPP buyers need no account.

| | Master key | Payment key |
|---|---|---|
| Prefix ([PC-7](platform-config.md)) | `srm_live_…`, `srm_test_…` in staging | `sr_live_…`, `sr_test_…` in staging |
| Per account | Exactly one | Any number |
| Works on | `api.servicerouter.ai`: the account, keys, services, secrets, balance, payments, earnings | `pay.servicerouter.ai`: paid calls with credits, and `/_/key` |
| Limits | None | Allowance, daily budget, maximum price per call, expiry |
| If lost | Recovery by email, when the account has a confirmed email. Without one, the account is lost. | The master key revokes it and creates another. |

The person keeps the master key. Each agent that spends gets only a payment key with limits. If one agent holds both, the limits still catch bugs, but a prompt injection can make the agent issue itself a bigger key.

## Requirements

- **AK-1** `POST /v1/accounts` creates an account and returns its master key once. The body is empty or `{ "email": "…" }`. No UI is needed, so an agent can sign up. From step 9, signup also creates a deposit address ([Deposits](deposits.md)) and a top-up link, and the response includes the link. The response states that a lost master key can't be recovered without a confirmed email.
  - The `201` response is `{ id, email, emailConfirmed, topupUrl, createdAt, masterKey, notice }`, with `Cache-Control: no-store`. Signup is rate limited per IP ([PA-5](platform-api.md)).
- **AK-2** `GET /v1/account` returns the account ID, the email and whether it's confirmed, and the top-up link.
- **AK-3** Keys are 32 random bytes after a prefix from platform config ([PC-7](platform-config.md)). Store only the SHA-256 hash. Look keys up by hash. A key is shown once: in the response that creates it.
  - The body is the 32 bytes in base62, 43 characters, so a key is one word on double-click.
  - `api_keys` holds the hash with a unique index, and a partial unique index allows one active master key per account.
- **AK-4** Each kind of key works on one host. A master key sent to the proxy, or a payment key sent to the Platform API, gets `401 wrong_key_type`. The prefix decides this before any lookup. A leaked payment key can't manage the account, and a master key can't pay.
- **AK-5** `POST /v1/account/master-key/rotate` returns a new master key. The old one stops working at once. It revokes the key the caller used, so a second rotation with the same old key gets `401 invalid_key`.
- **AK-6** The master key manages payment keys: `POST /v1/keys`, `GET /v1/keys`, `PATCH /v1/keys/{id}`, `DELETE /v1/keys/{id}`.

  ```
  POST /v1/keys
  { "label": "n8n", "allowance": "20.00", "dailyBudget": "5.00", "maxPrice": "0.05", "expiresAt": "2026-10-06T19:50:00+08:00" }
  → { "id": "key_…", "key": "sr_live_…", "label": "n8n", … }
  ```

  - `allowance`: USD the key may spend over its life. Optional. Without it, only the balance and the other limits apply.
  - `dailyBudget`: USD per day, reset at midnight UTC ([AR5](README.md#8-open-questions)). Defaults to [AR4](README.md#8-open-questions).
  - `maxPrice`: the highest price of one call. Optional.
  - `expiresAt`: optional. An expired key is refused like a revoked one.
  - `label`: free text for the owner, up to 60 characters.

  Amounts are USD decimal strings ([CK-4](common-kit.md)). These limits cover credits only. x402 and MPP buyers have no key: their wallets set their limits.

  - A key in a response is `{ id, label, allowance, dailyBudget, maxPrice, expiresAt, createdAt, revokedAt, spent: { today, total }, remaining: { allowance, dailyBudget } }`, with `null` for a limit that isn't set. Only the `201` of `POST` adds `key`, with `Cache-Control: no-store`.
  - `GET /v1/keys` lists every payment key of the account, revoked ones too, newest first, never with the key or its hash.
  - `PATCH` changes only the fields it sends. `null` clears `allowance`, `maxPrice`, `expiresAt`, or `label`. `dailyBudget` can change but not be cleared. `expiresAt` must be in the future.
  - `DELETE` answers `{ id, revokedAt }`. Another account's key, an unknown one, or a revoked one is `404 not_found` for `PATCH` and `DELETE`.
  - The limits are columns on `api_keys`: `allowance`, `daily_budget`, `max_price` in micro-USD, and `expires_at`. A `CHECK` gives every payment key a daily budget and keeps master keys without limits.
- **AK-7** An allowance is a cap, not money moved to the key. The credits stay in the account balance. A call goes through only when the balance covers it and every limit of the key allows it. The Ledger checks both in one hold ([LG-6](ledger.md)). Revoking a key leaves nothing to return.
- **AK-8** `GET pay.servicerouter.ai/_/key` with a payment key returns the key's limits and what's left: of the allowance, of today's budget, and of the balance. An agent can check before it calls.
  - The body is `GET /v1/keys`'s fields without `revokedAt`: `{ id, label, allowance, dailyBudget, maxPrice, expiresAt, createdAt, spent: { today, total }, remaining: { allowance, dailyBudget, balance } }`, with `Cache-Control: no-store`. It counts against the key's rate limit.
- **AK-9** The proxy and the Platform API cache key lookups briefly. Creating, revoking, or changing a key, and rotating the master key, publish an invalidation event. The change applies at once, not at the end of the cache TTL.
  - The Platform API doesn't cache master keys: every request looks up the hash, so a rotation applies at once without an event. The proxy's payment-key cache (step 4) needs the event.
  - Creating, changing, or revoking a payment key publishes `{ kind: 'key', id }` after the commit. Publishing is best effort, with a 2 s timeout: a failure is logged, and the cache TTL still applies.
  - The proxy caches payment keys by hash for 60 s, and unknown hashes for 10 s. A key event drops the key, and a lookup running at that moment isn't kept. A reconnect of the subscription drops every key.
**After the MVP** (owner, 2026-10-06T19:50:00+08:00, [AR19](README.md#8-open-questions)): AK-10 to AK-14, email and recovery. In the MVP a lost master key can't be recovered.

- **AK-10** Email is optional. An email at signup, or `PUT /v1/account/email`, sends a confirmation link. The email serves recovery and notices only once it's confirmed. A change sends a notice to the old confirmed address.
- **AK-11** Recovery: `POST /v1/account/recover` with `{ "email": "…" }` sends a recovery link to a confirmed email.
  - The response is the same whether or not the email belongs to an account.
  - The link opens the recovery page. The page calls `POST /v1/account/recover/confirm` with the link's token. That returns a new master key once and revokes the old one.
  - Payment keys keep working. The page lists them, so the owner can revoke any they don't recognize.
- **AK-12** Email links:
  - single use, valid for 15 minutes, stored as a SHA-256 hash in `email_links`;
  - they carry a token, never a key;
  - a page uses the token only when the person presses a button, never on load: mail scanners open links;
  - rate limited per account and per IP.
- **AK-13** Notices go to the confirmed email: a master key rotation, a recovery, an email change, and payout changes ([OV-10](ownership-verification.md)). A notice never contains a key or a link that acts on the account.
- **AK-14** Email goes out through the SMTP relay in platform config ([AR19](README.md#8-open-questions)), from `api` and `workers`, through a `Mailer` port. Tests use a fake mailer.
- **AK-15** The top-up link uses its own random token. It isn't derived from any key, and it reveals only the deposit address and deposit status.
  - 24 random bytes, base64url. The link is `<urls.website>/topup/<token>`. Signup and `GET /v1/account` answer with `topupUrl` and `depositAddress: { address, network, asset }`, both `null` while deposits are off.
- **AK-16** Every key creation, rotation, revocation, limit change, email change, and recovery writes the audit log, without the key.
  - Actions so far: `account.create`, `master_key.rotate`, `payment_key.create`, `payment_key.update`, and `payment_key.revoke`, with key IDs in the details, in the same transaction as the change. Limits are recorded in micro-USD.
- **AK-17** Later: register both key prefixes with GitHub secret scanning. A key that GitHub reports in a public repository is revoked at once, and the owner gets a notice.
