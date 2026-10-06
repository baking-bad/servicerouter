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
  - Parameters: a 32-byte data key, a 12-byte IV, and a 16-byte tag. RSA-OAEP with SHA-256 for both the hash and MGF1, with RSA keys of at least 3072 bits.
  - The sealer takes the public key only and refuses a private key, so the Platform API can never be handed one.
  - `scripts/secrets-keygen.mjs` prints a new key pair with its key ID.
- **SC-3** Bind each ciphertext to its service ID and secret name as AES-GCM associated data. A row copied to another service doesn't decrypt.
  - The associated data is length-prefixed, so no two different inputs encode the same way: `field(label) ‖ u8(version) ‖ field(keyId) ‖ field(serviceId) ‖ field(name) ‖ field(origin)`, where `field(s)` is the 4-byte big-endian UTF-8 length of `s`, then its UTF-8 bytes, and the label is `servicerouter.sealed-secret`. The origin is SC-10's.
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
- **SC-10** A secret is bound to the origin of the upstream it is sent to, such as `https://api.example.com`, as part of the associated data (SC-3). The proxy opens it only with that origin, so a revision that points an upstream at another host, written by anyone, including a compromised Platform API, can't make the proxy send the secret there.
  - A secret used by upstreams on two origins is a validation error. Each host gets its own secret.
  - A submit that moves an upstream to another origin must send that upstream's secrets again, in the same request. Otherwise it fails validation, naming the secrets.
  - A rollback to a revision whose upstreams use other origins than the stored secrets is refused, naming the secrets to send again.
  - A sent secret that the config doesn't use is refused: it has no origin to be bound to.
  - The origin is also stored on the row, in clear, so the Platform API can check the rules above without opening anything.

## Error codes

| Code | When |
|---|---|
| `secret_open_failed` | A sealed secret didn't open: tampering, another service, name, or origin, an unknown key ID, or an unsupported version. One code, so the caller can't tell which. |
| `secret_key_invalid` | The sealer or opener was given a key it can't use: a private key to the sealer, a key under 3072 bits, or not an RSA key. |
