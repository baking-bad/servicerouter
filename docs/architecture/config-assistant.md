# Config assistant

Status: **draft**. Part of the [architecture overview](README.md).

Drafts a seller config from an OpenAPI link. The seller pastes the link, the assistant drafts the config and prices, and the seller reviews and edits it.

| | |
|---|---|
| Package | `api` |
| Owns | No data. Drafts aren't stored. |
| Depends on | [Service registry](service-registry.md) (validation), [Outbound HTTP](outbound-http.md), an LLM |
| [Build step](README.md#7-build-order) | 14 |

## Requirements

- **CA-1** `POST /v1/assistant/drafts` takes an OpenAPI URL and returns a draft config with suggested prices. It never submits or activates anything.
- **CA-2** Code maps what is mechanical:
  - `servers` → `upstreams[].baseUrl`;
  - `securitySchemes` → `credentials`;
  - operations → route keys.

  An LLM fills in what needs judgment: description, summary, category, tags, and prices.
- **CA-3** The draft passes the same validation as a submit ([SR-2](service-registry.md)) before it's returned.
- **CA-4** Fetches through Outbound HTTP. The OpenAPI document is untrusted input to the model.

## As built in step 14

- **The request:** `POST /v1/assistant/drafts`, behind the master key, with `{ openapi, payoutAddress, id? }`. The seller gives the payout address, so a draft never carries a placeholder that pays nobody. The answer is `{ id, config: { mediaType: "application/yaml", text }, warnings, notes, submitted: false }`. Drafts are limited per account (`rateLimits.assistant`, 30 an hour by default).
- **The mechanical mapping (CA-2):**
  - `servers[0].url` is resolved against the document's link, or the link's origin without one.
  - `http` bearer and basic, and `apiKey` in a header, query, or cookie, become credentials with a secret named after each scheme. Other schemes, such as OAuth, are left out with a note.
  - Operations with an `operationId` become route keys. The most common suggested price is `payments.default`; the others become route payments.
- **The model** sits behind the `LlmDrafter` port: the title, the description, the operations, and the category list go in, and the summary, description, category, tags, and prices come back. Its answer is bounded (CA-4): a category outside the list falls back with a note, an invalid price becomes the default ($0.001), and tags must be short slugs. No adapter is wired yet. The default drafter uses the document's own words, the first category, and the default price, for the seller to review.
- **Validation (CA-3):** passes 1 to 3 of a submit, with the secrets still to come (warnings). A draft that doesn't pass is `400 invalid_config`, with every problem.
