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
