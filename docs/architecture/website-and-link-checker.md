# Website and link checker

Status: **draft**. Part of the [architecture overview](README.md).

The public pages for people, and the page that checks whether an x402 or MPP link can be paid through the platform.

| | |
|---|---|
| Packages | `web`, `proxy` (serves the link checker) |
| Hosts | `servicerouter.ai`. The link checker at `pay.servicerouter.ai/`. |
| Depends on | [Platform API](platform-api.md), [Payment routing](payment-routing.md) |
| [Build step](README.md#7-build-order) | 15, built beside steps 7 to 14 (owner, 2026-10-06T19:50:00+08:00): every page and the console, with sample data until their endpoints ship (WB-10). The link checker page comes with its endpoint, in step 12 |

## Requirements

- **WB-1** Pages on `servicerouter.ai`:
  - the landing page;
  - `/discover`: all services, grouped by category, with filters in the query, such as `?category=finance/market-data`;
  - `/discover/<service-id>`: description, links, prices, stats, and links to the agent docs;
  - the top-up page;
  - the email confirmation page and the recovery page ([AK-12](accounts-and-keys.md)), after the MVP with email ([AR19](README.md#8-open-questions));
  - `llms.txt` and the platform skills ([AD-5](agent-docs.md), AD-7);
  - the console (WB-8).
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
- **WB-6** Next.js 16 (App Router) and React 19 in `packages/web`, built separately into its own image, `servicerouter-web` ([AR11](README.md#8-open-questions)).
  - It reads its settings from the environment at runtime, so one image serves every deployment: `SITE_URL`, `API_URL`, `PAY_URL`, and `WEB_MOCKS` (WB-10).
  - `/_/health` answers for the stack's health check.
- **WB-7** After the MVP, with email. The recovery page shows the new master key once, with a copy button and a warning that it won't be shown again. It lists the account's payment keys, so the owner can revoke any they don't recognize ([AK-11](accounts-and-keys.md)). It stores nothing in the browser.
- **WB-8** A console for people at `/console`, signed in with a master key. Approved by the owner on 2026-10-06T19:50:00+08:00.
  - **Signing in and up.** Sign in with a master key, checked with `GET /v1/account`. Sign up with `POST /v1/accounts`: the page shows the new master key once, with a copy button, and says it can't be recovered in the MVP ([AR19](README.md#8-open-questions)).
  - **Where the key lives.** In the tab only: in memory and in `sessionStorage`, gone when the tab closes. Never in `localStorage` or a cookie, and never on the web server: the browser sends it only to the Platform API (WB-2). Signing out clears it.
  - **Buyers:** the balance, available and held; spend today and over 30 days, by day and by service; payment keys, created with limits and shown once, with limits changed and keys revoked; payments, paged, newest first; the top-up page (WB-3).
  - **Sellers:** their services (`GET /v1/services`), each with its state, its revisions and rollback, its earnings by rail ([LG-10](ledger.md)), its status ([OV](ownership-verification.md), step 8), and its stats (CI-4, step 13).
  - **Account:** the account ID, rotating the master key (the new key is shown once), and signing out.
  - It steers people to give agents payment keys, never the master key.
  - A sample-data mode shows the whole console without an account (WB-10).
  - Mint `#18D2A5` on the dark canvas, and `#109373` on light surfaces.
  - The favicon, the app icons, and the social preview images are generated from the same paths, never redrawn or rasterized by hand.
  - The website keeps one copy of the paths in its source.
- **WB-10** Sample data (owner, 2026-10-06T19:50:00+08:00).
  - A page whose Platform API endpoint isn't built yet reads fixtures with that endpoint's documented response shape, and labels them "Sample data".
  - `WEB_MOCKS` names the groups served from fixtures: `catalog` (CI-5, step 13), `agent-docs` (AD-1, AD-2, step 10), `topup` (DP-5, step 9), and `status` (OV, step 8). Each group moves to its real endpoint when its step ships.
  - Sample data is allowed in production while the platform is in development.
- **WB-11** For agents. No MCP server (owner, 2026-10-06T19:50:00+08:00).
  - `/llms.txt` is the platform guide (AD-5) in the llms.txt format. `/llms-full.txt` has the guide, both skills, and the catalog in one file.
  - The platform Agent Skills are at `/skills/servicerouter-buyer/SKILL.md` and `/skills/servicerouter-seller/SKILL.md` (AD-5, AD-7).
  - Every public page has a Markdown version: its URL with `.md` (`/index.md` for the landing page), or its own URL requested with `Accept: text/markdown`. Each page links it with `<link rel="alternate" type="text/markdown">`.
  - Service pages link the service's OpenAPI document, `llms.txt`, and Agent Skill (AR1), and offer a one-line prompt to copy into an agent.
  - `robots.txt` lets every crawler in, AI crawlers included, except into `/console`. `sitemap.xml` lists the public pages and every service. Service pages carry schema.org JSON-LD.
- **WB-12** Security headers on every page:
  - a Content-Security-Policy with a nonce per request: scripts only from the site, with the nonce, and no third-party scripts; `connect-src` only the site and the Platform API; `frame-ancestors 'none'`;
  - `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

  The console holds a master key, so the site loads nothing it doesn't serve itself.
