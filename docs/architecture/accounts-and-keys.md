# Accounts and keys

Status: **draft**. Part of the [architecture overview](README.md).

Accounts, their master and payment keys, and account recovery by email.

| | |
|---|---|
| Packages | `core`, `db`, `api`, `web` (email pages) |
| Owns | `accounts`, `api_keys` with limits, `email_links` |
| Depends on | [Platform config](platform-config.md) (key prefixes, default limits, SMTP relay), [Deposits](deposits.md) (deposit address at signup), [Website](website-and-link-checker.md) (email pages) |
| [Build step](README.md#7-build-order) | 2 (accounts, master keys), 4 (payment keys), 9 (email, recovery) |

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
- **AK-2** `GET /v1/account` returns the account ID, the email and whether it's confirmed, and the top-up link.
- **AK-3** Keys are 32 random bytes after a prefix from platform config ([PC-7](platform-config.md)). Store only the SHA-256 hash. Look keys up by hash. A key is shown once: in the response that creates it.
- **AK-4** Each kind of key works on one host. A master key sent to the proxy, or a payment key sent to the Platform API, gets `401 wrong_key_type`. The prefix decides this before any lookup. A leaked payment key can't manage the account, and a master key can't pay.
- **AK-5** `POST /v1/account/master-key/rotate` returns a new master key. The old one stops working at once.
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
- **AK-7** An allowance is a cap, not money moved to the key. The credits stay in the account balance. A call goes through only when the balance covers it and every limit of the key allows it. The Ledger checks both in one hold ([LG-6](ledger.md)). Revoking a key leaves nothing to return.
- **AK-8** `GET pay.servicerouter.ai/_/key` with a payment key returns the key's limits and what's left: of the allowance, of today's budget, and of the balance. An agent can check before it calls.
- **AK-9** The proxy and the Platform API cache key lookups briefly. Creating, revoking, or changing a key, and rotating the master key, publish an invalidation event. The change applies at once, not at the end of the cache TTL.
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
- **AK-16** Every key creation, rotation, revocation, limit change, email change, and recovery writes the audit log, without the key.
- **AK-17** Later: register both key prefixes with GitHub secret scanning. A key that GitHub reports in a public repository is revoked at once, and the owner gets a notice.
