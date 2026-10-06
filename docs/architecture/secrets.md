# Secrets

Status: **draft**. Part of the [architecture overview](README.md).

Seller credentials for upstreams, such as the seller's own API key.

| | |
|---|---|
| Packages | `core` (port), `db` (adapter), `api` (write endpoints), `proxy` (opens them) |
| Owns | `service_secrets` |
| Depends on | [Common kit](common-kit.md) (`Secret`), [Service registry](service-registry.md) (the submit envelope) |
| [Build step](README.md#7-build-order) | 2 |

## Requirements

- **SC-1** Write-only: the `secrets` field of a config submit ([SR-12](service-registry.md)), or `PUT /v1/services/{id}/secrets/{name}` to rotate one without a new revision. No endpoint returns a value, a hash, or a length. The status shows only whether a secret is set, and when.
- **SC-2** Envelope encryption: AES-256-GCM with a fresh data key per secret. Wrap the data key with the proxy's public key (RSA-OAEP-256). The Platform API can seal secrets but can't open them. Store the key ID on each row, so the key pair can rotate.
- **SC-3** Bind each ciphertext to its service ID and secret name as AES-GCM associated data. A row copied to another service doesn't decrypt.
- **SC-4** The private key comes from the stack's secrets and lives in `Secret`.
- **SC-5** The proxy opens secrets only when it loads a runtime, and binds them to the runtime's credential references. Opened values stay in `Secret` and are destroyed when the runtime leaves the cache.
- **SC-6** Secrets never appear in revisions, logs, errors, or responses.
- **SC-7** Writing a secret invalidates the service's runtime, the same as an activation.
- **SC-8** Every write goes to the audit log, without the value.
- **SC-9** Secrets sent with a config submit:
  - Parse the envelope as JSON first and take `secrets` out before the config is parsed. A YAML error can never quote a secret.
  - Seal each value at once (SC-2) and drop the plain value. Validation sees names only.
  - Write the secrets and the revision in one database transaction. If validation fails, nothing is written.
  - Errors name a secret, never echo its value.
  - Secrets belong to the service, not to a revision. They apply at once, even when the revision waits for verification or a payout confirmation.
