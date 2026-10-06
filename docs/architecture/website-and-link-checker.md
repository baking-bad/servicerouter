# Website and link checker

Status: **draft**. Part of the [architecture overview](README.md).

The public pages for people, and the page that checks whether an x402 or MPP link can be paid through the platform.

| | |
|---|---|
| Packages | `web`, `proxy` (serves the link checker) |
| Hosts | `servicerouter.ai`. The link checker at `pay.servicerouter.ai/`. |
| Depends on | [Platform API](platform-api.md), [Payment routing](payment-routing.md) |
| [Build step](README.md#7-build-order) | 9 (top-up page, email pages), 12 (link checker), 13 (catalog pages) |

## Requirements

- **WB-1** Pages on `servicerouter.ai`:
  - the landing page;
  - `/discover`: all services, grouped by category, with filters in the query, such as `?category=finance/market-data`;
  - `/discover/<service-id>`: description, links, prices, stats, and links to the agent docs;
  - the top-up page;
  - the email confirmation page and the recovery page ([AK-12](accounts-and-keys.md));
  - `llms.txt` ([AD-5](agent-docs.md)).
- **WB-2** Reads only the public Platform API. No database access and no secrets.
- **WB-3** The top-up page shows the deposit address with a QR code, the asset (USDM on Cardano), and deposit status, by the top-up token ([DP-5](deposits.md)).
- **WB-4** The link checker is a static page that the proxy serves at `/`, with its files under `/_/`. The user pastes an x402 or MPP link. The page calls `GET /_/check` ([RT-19](payment-routing.md)) and shows whether the link is payable, the price, and the routing link. It stores no credentials, because seller responses share its origin ([PX-9](proxy.md)).
- **WB-5** Follows the Baking Bad house style:
  - dark first: canvas `#17191B`, cards `#202225`;
  - text is white at 90 %, 75 %, 65 %, and 35 % opacity for primary, body, secondary, and labels;
  - one accent, mint `#18D2A5`, for the brand, the active state, and the main action. Text on mint is black;
  - Inter for UI text, mostly 12–13 px at weight 600. JetBrains Mono for addresses, hashes, and code;
  - edges are inset rings of 5–10 % white, not solid borders. Resting cards have no shadow;
  - cards have a 12 px radius and 16 px padding. Buttons and inputs have a 6 px radius;
  - tabular numbers for amounts and counters.
- **WB-6** The stack is an open question ([AR11](README.md#8-open-questions)).
- **WB-7** The recovery page shows the new master key once, with a copy button and a warning that it won't be shown again. It lists the account's payment keys, so the owner can revoke any they don't recognize ([AK-11](accounts-and-keys.md)). It stores nothing in the browser.
