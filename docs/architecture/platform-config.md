# Platform config

Status: **draft**. Part of the [architecture overview](README.md).

Everything about a deployment that isn't a seller config or a secret.

| | |
|---|---|
| Package | `core` (schema, types) |
| Owns | One YAML file per deployment, in the repo |
| Used by | Every app |
| [Build step](README.md#7-build-order) | 1 |

## Requirements

- **PC-1** One file per deployment: staging and production. Load it at boot with the strict YAML loader ([CK-8](common-kit.md)) and validate it with JSON Schema (`additionalProperties: false` everywhere). An app with an invalid config doesn't start.
- **PC-2** It holds:
  - canonical public URLs and the hosts we own;
  - the asset registry (PC-6);
  - the facilitator registry: name, URL, networks, auth reference, and `enabled` (default true: a disabled one isn't checked, and its networks aren't offered);
  - deposits ([DP-1](deposits.md)), optional: `asset` (a Cardano asset of the registry), `confirmations` (default 15), `enabled` (default true), and `blockfrostUrl` (default Blockfrost's for the asset's network);
  - `payTo` addresses per network and the MPP recipient on Tempo;
  - `feeBps` (registered services) and `routingFeeBps` (payment routing);
  - the minimum payout;
  - the category list;
  - rate limits, including the signup limit per client IP (`rateLimits.signup`, [PA-5](platform-api.md)) the top-up data's (`rateLimits.topup`, default 60 a minute), and the agent documents' and the catalog's (`rateLimits.documents`, default 120 a minute), and timeouts;
  - Signer limits;
  - key prefixes (PC-7) and the default limits for new payment keys ([AR4](README.md#8-open-questions));
  - the SMTP relay: host, port, sender address, and credentials by name, after the MVP ([AR19](README.md#8-open-questions)).
- **PC-3** Secrets appear by name only. Their values come from the stack's environment.
- **PC-4** Read-only at runtime. A change ships as a deploy.
- **PC-5** Staging and production differ only in this file and in secrets: testnets, key prefixes, hosts. The MVP deploys production only, on mainnets ([README section 6](README.md#6-deployment)). `config/example.yaml` is the testnet-shaped config for tests.
- **PC-6** The asset registry has one entry per accepted asset: name, network (CAIP-2), asset address, decimals, USD peg, minimum price, `payTo`. At launch:

| Name | Network | Asset |
|---|---|---|
| `base-usdc` | `eip155:8453` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `solana-usdc` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `cardano-usdm` | `cardano:mainnet` | `c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d` |

  - Take decimals from the SDK defaults, such as `DEFAULT_ASSETS` in `@x402/cardano`. Don't hard-code them from memory.
  - Staging uses the testnet equivalents: Base Sepolia, Solana devnet, Cardano preprod.
  - Pegged stablecoins convert 1:1 to USD. Volatile assets such as ADA aren't supported: they need a price feed.
  - The minimum price keeps costly options out of cheap calls. On Cardano, the buyer pays about 0.17 ADA in network fees per transaction, which is more than a $0.001 call.
  - **Tempo assets** serve MPP ([PR-9](payment-rails.md)): USD stablecoins on the `mpp.network`, such as USDC.e on Tempo mainnet in production, and pathUSD on Tempo Moderato in the test config. They need no facilitator, their `payTo` is the MPP recipient, and x402 doesn't offer them.
  - `mpp.enabled` (default true) turns MPP off, like a facilitator's `enabled`. `mpp.rpcUrl` (optional, default the chain's public RPC) is the Tempo RPC the proxy and workers use. It holds no credential.

- **PC-7** Key prefixes, one per kind of key ([Accounts and keys](accounts-and-keys.md)):

  ```yaml
  keyPrefixes:
    master: srm_live_     # srm_test_ in staging
    payment: sr_live_     # sr_test_ in staging
  ```

  - The two must differ, and neither may start with the other, so the first characters tell a key's kind. Validation rejects a config that breaks this.
  - Staging and production use different prefixes, so a staging key never works in production.
  - Keys carry their prefix. After a prefix change, existing keys of that kind stop being recognized. Set prefixes before launch and don't change them.
