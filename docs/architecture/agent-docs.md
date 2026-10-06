# Agent docs

Status: **draft**. Part of the [architecture overview](README.md).

Documents that tell agents how to call a service through the platform.

| | |
|---|---|
| Packages | `core` (generators), `api` (serving) |
| Owns | `service_documents`, one set per revision |
| Depends on | [Service registry](service-registry.md) |
| [Build step](README.md#7-build-order) | 10 |

An agent that already knows a seller's service reads its `llms.txt`, Agent Skill, or API docs, which explain how to call it through the proxy. By default it pays with credits, unless the buyer chooses x402 or MPP.

## Requirements

- **AD-1** For each active revision, generate an OpenAPI 3.1 document: the seller's operations, `servers[0].url` set to `https://pay.servicerouter.ai/service/<service-id>`, a price per operation in `x-payment-info`, and the payment key as a bearer security scheme. No upstream URLs and no seller credentials. An agent can take the seller's own document, swap `servers[0].url`, and use it.
  - As built in step 10: each enabled operation keeps the seller's object, with the path item's parameters merged in, and without `servers`, `security`, and `callbacks`. `components` are kept without `securitySchemes`. `x-payment-info` is `{ price, currency: "USD", methods }`, where `methods` lists `credits`, `x402`, and `mpp` as the assets' minimum prices allow. `info.version` is the revision.
- **AD-2** From the same model, generate `llms.txt` and an Agent Skill: what the service does, how to pay (credits first, then x402 and MPP), routes, prices, and examples.
- **AD-3** Generate x402 Bazaar discovery metadata per operation: a description, input and output schemas, and an example. A good Bazaar listing needs all of them. Store it in the runtime, so [PR-7](payment-rails.md) adds it with no work on the hot path. Use the SDK's Bazaar extension. Check its current API before building.
  - Step 10 generates it per paid operation and stores it with the documents (`bazaar.json`, not served). The Bazaar extension is in `@x402/extensions`, which the stack doesn't have yet. Adding it, putting the metadata in the runtime, and attaching it to the challenge (PR-7) wait for the owner's approval of the dependency and P-4.
- **AD-4** Regenerate on every activation. Serve with an `ETag`, at the URLs in [AR1](README.md#8-open-questions).
  - As built: generated on the first request after an activation, and stored per revision in `service_documents` with a hash of everything they're made from (the revision, the platform's URLs and key prefix, each price's methods, and the generator's version). A changed hash makes them again. Only `live` services have documents: others are `404`.
  - `GET /v1/services/{id}/openapi.json`, `…/llms.txt` (`text/plain`), and `…/skill.md` (`text/markdown`), without a key. They carry a strong `ETag`, answer `304` to `If-None-Match`, and have `Cache-Control: public, max-age=60, must-revalidate`. They're limited per client IP (`rateLimits.documents`, 120 a minute by default).
- **AD-5** A platform onboarding guide for first-time buyers: `servicerouter.ai/llms.txt` and a platform Agent Skill. It explains how the platform works and suggests credits as the default. The guide also covers routing links. It lives in the repo and is versioned with the code. The website serves the guide and the skills ([WB-11](website-and-link-checker.md)), built beside the other steps since 2026-10-06T19:50:00+08:00, and the `402`'s guide link points at `servicerouter.ai/llms.txt`. With the user's confirmation, the agent:
  1. signs up with `POST /v1/accounts` and keeps the master key in a file only the user can read;
  2. tells the user that a lost master key can't be recovered without a confirmed email, and offers to add one. In the MVP, with no email ([AR19](README.md#8-open-questions)), it says the key can't be recovered at all, and asks the user to keep a copy safe;
  3. creates a payment key with limits the user agrees to, and suggests the user keep the master key and give agents only payment keys ([Accounts and keys](accounts-and-keys.md));
  4. gives the user the top-up link and starts calling once the deposit is confirmed.
- **AD-6** Generation is deterministic: the same revision gives byte-identical documents. Tests compare them with fixtures.
- **AD-7** A platform Agent Skill for sellers, next to the buyer guide. It uses only plain HTTP calls, such as `curl`: sellers install no SDK. It covers:
  - signup and keeping the master key safe (AD-5, steps 1–2);
  - drafting a config ([Config assistant](config-assistant.md)) and submitting it with its secrets ([SR-12](service-registry.md));
  - publishing the `.well-known/servicerouter.json` file and checking the service status ([Ownership verification](ownership-verification.md));
  - confirming a payout change ([OV-10](ownership-verification.md)).

  It lives in the repo and is versioned with the code.
