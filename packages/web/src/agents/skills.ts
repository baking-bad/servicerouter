import type { SiteSettings } from '../config';
import { buyerSkillPath, sellerSkillPath } from './guide';

// The platform Agent Skills (AD-5, AD-7): Markdown with the Agent Skills frontmatter, `name` and
// `description`. They use plain HTTP calls with curl: no SDK to install.

export interface PlatformSkill {
  readonly name: string;
  readonly path: string;
  readonly description: string;
  readonly body: (settings: SiteSettings) => string;
}

const buyer: PlatformSkill = {
  name: 'servicerouter-buyer',
  path: buyerSkillPath,
  description: 'Pay for API calls through Service Router with credits, x402, or MPP. Use when the user wants an agent to call a paid API listed on Service Router, to sign up, to create a payment key with limits, or to check spending.',
  body: ({ siteUrl, apiUrl, payUrl }) => `# Service Router for buyers

Service Router lets an agent call paid APIs, paying per call. Credits, a prepaid USD balance, are the default. Every listed service is at \`${payUrl}/service/<service-id>/<path>\`.

Ask the user before you sign up, create a key, or spend anything.

## 1. Sign up once

\`\`\`sh
curl -s -X POST ${apiUrl}/v1/accounts > servicerouter-account.json
chmod 600 servicerouter-account.json
\`\`\`

The answer's \`masterKey\` controls the account. Keep it in that file, readable only by the user. Never print it, paste it into a chat, or put it in a URL. Tell the user: a lost master key can't be recovered, because there is no email recovery yet. Ask them to keep a copy safe.

## 2. Create a payment key for the agent

Agents call with a payment key, never the master key. Agree on its limits with the user first.

\`\`\`sh
MASTER_KEY=$(jq -r .masterKey servicerouter-account.json)
curl -s -X POST ${apiUrl}/v1/keys \\
  -H "Authorization: Bearer $MASTER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"label": "my-agent", "dailyBudget": "5", "allowance": "20", "maxPrice": "0.05"}'
\`\`\`

The \`key\` in the answer is shown once: store it like the master key. \`GET ${apiUrl}/v1/keys\` lists keys and what each spent. \`PATCH ${apiUrl}/v1/keys/<id>\` changes limits. \`DELETE ${apiUrl}/v1/keys/<id>\` revokes one.

## 3. Top up

\`GET ${apiUrl}/v1/account\` (master key) returns \`topupUrl\`. Give it to the user: it shows a deposit address for USDM on Cardano. Credits arrive once the deposit confirms. \`GET ${apiUrl}/v1/balance\` shows the balance. While \`topupUrl\` is null, deposits aren't open yet: pay per call with x402 or MPP (step 5).

## 4. Find and call a service

- The catalog: \`${siteUrl}/discover.md\`, filtered with \`?q=\`, \`category=\`, \`method=\`, \`maxPrice=\`, and \`sort=popular|price|newest|success\`.
- A service: \`${siteUrl}/discover/<service-id>.md\` lists its routes and prices, and links its \`llms.txt\`, Agent Skill, and OpenAPI document.

\`\`\`sh
curl ${payUrl}/service/<service-id>/<path> -H "Authorization: Bearer $SERVICEROUTER_PAYMENT_KEY"
\`\`\`

- Only \`2xx\` answers are charged. Each carries \`Servicerouter-Receipt\` with the payment ID and amount.
- \`GET ${payUrl}/_/key\` (payment key) shows the key's limits and what's left.
- \`402\` codes: \`insufficient_balance\` (top up), \`key_budget_exceeded\` (wait for midnight UTC, or ask the user to raise it), \`key_allowance_exceeded\`, \`key_price_limit\`.
- \`401 wrong_key_type\`: a master key was sent. Use the payment key.
- \`429 rate_limited\`: wait for \`Retry-After\` seconds.
- \`503 upstream_unavailable\`: the service failed. You weren't charged.

## 5. Without an account: x402 or MPP

A call without a credential answers \`402\` with every option:
- \`PAYMENT-REQUIRED\`: x402 v2. Sign an option with an x402 client, and retry with \`PAYMENT-SIGNATURE\`.
- \`WWW-Authenticate: Payment\`: an MPP Tempo charge. Sign it in pull mode, with \`mppx\` for example, and retry with \`Authorization: Payment …\` at once: the transaction expires within about 25 seconds.

Payment settles only after a \`2xx\` answer.

## 6. Any x402 or MPP API, listed or not

Put \`${payUrl}/\` in front of the API's URL, without \`https://\`:

\`\`\`sh
curl ${payUrl}/api.example.com/v1/pools -H "Authorization: Bearer $SERVICEROUTER_PAYMENT_KEY"
\`\`\`

Service Router pays the API in its own protocol, x402 on Base or MPP on Tempo, and returns its answer. You pay the quote, the API's price plus any routing fee, with the payment key, or with an option of the \`402\` (step 5), such as x402 with USDM on Cardano. \`GET ${payUrl}/_/check?url=<link>\` quotes a link without paying. \`502 unsupported_payment\`: the API asks for no payment Service Router makes. You weren't charged.
`,
};

const seller: PlatformSkill = {
  name: 'servicerouter-seller',
  path: sellerSkillPath,
  description: 'List an API on Service Router and get paid per call by agents. Use when the user wants to sell access to their API, write or submit a Service Router config, rotate upstream secrets, roll back a revision, or check earnings.',
  body: ({ siteUrl, apiUrl, payUrl }) => `# Service Router for sellers

Service Router sells per-call access to an HTTP API. Agents call \`${payUrl}/service/<service-id>/<path>\` and pay with credits, x402, or MPP. The platform forwards each paid call to the upstream with the seller's credentials, which agents never see, and pays the seller.

Show the user the config before you submit it. Never print secret values.

## 1. Sign up once

\`\`\`sh
curl -s -X POST ${apiUrl}/v1/accounts > servicerouter-account.json
chmod 600 servicerouter-account.json
\`\`\`

The \`masterKey\` controls the account and its earnings. Keep it in that file. A lost master key can't be recovered yet.

## 2. Write the config

One YAML file describes the service, its upstream, its prices, and its payout:

\`\`\`yaml
servicerouter:
  version: "1"

service:
  id: my-prices              # [a-z0-9-], unique, in the URL forever
  title: My Prices
  summary: Live token prices by symbol
  description: |
    The latest price, 24-hour change, and volume for any token symbol.
  category: crypto/prices    # One ID of the catalog's categories: \`GET ${apiUrl}/v1/catalog\` lists them
  tags: [prices, tokens]
  discoverable: true         # Listed in the x402 Bazaar. false keeps it out

payouts:
  default:
    asset: cardano-usdm      # Paid out in USDM on Cardano
    address: addr1...        # Your Cardano address

payments:
  default:
    amount: "0.001"          # USD per call

upstreams:
  - baseUrl: https://api.example.com
    openapi: https://api.example.com/openapi.json   # Or an inline \`paths\` object
    auth: main-key

credentials:
  main-key:
    type: http
    scheme: bearer           # Authorization: Bearer <secret>
    secret: upstream-key     # A name: the value is sent separately
\`\`\`

- Each operation of the OpenAPI document becomes a route at the same path. \`routes.<operationId>\` sets a route's own \`payment\`, a \`target\` path, or \`enabled: false\`.
- An amount of \`"0"\` makes a route free.
- \`service.discoverable\` (default \`true\`) lists each paid route in the x402 Bazaar, Coinbase's catalog of x402 APIs, once a payment for it settles through Coinbase's facilitator: its 402 carries the route's description, input and output schemas, and response example from your OpenAPI document. \`discoverable: false\` keeps the service out of it. Changing it makes a new revision, like any change.

## 3. Submit it with its secrets

\`\`\`sh
MASTER_KEY=$(jq -r .masterKey servicerouter-account.json)
jq -n --rawfile config service.yaml --arg key "$UPSTREAM_KEY" \\
  '{config: $config, secrets: {"upstream-key": $key}}' |
curl -s -X PUT ${apiUrl}/v1/services/my-prices \\
  -H "Authorization: Bearer $MASTER_KEY" \\
  -H "Content-Type: application/json" \\
  --data-binary @-
\`\`\`

- \`201\` creates the service, \`200\` updates it, and each change is a new revision.
- \`400 invalid_config\` lists every problem with its path, line, and column. Fix them and submit again.
- Secrets are sealed and bound to the host they go to. A config with no new secrets can be sent as YAML, with \`Content-Type: application/yaml\`.

## 4. Check and manage it

- \`GET ${apiUrl}/v1/services\`: your services. \`GET ${apiUrl}/v1/services/my-prices\`: one service.
- \`GET …/revisions\` lists revisions. \`POST …/rollback\` with \`{"revision": 3}\` makes an older one active.
- \`PUT …/secrets/<name>\` with \`{"value": "…"}\` rotates one secret.
- \`GET …/earnings\`: calls, earnings by payment method, the fee, pending payout, and the next payout date.
- Its public page: \`${siteUrl}/discover/my-prices\`.

## 5. Prove you own the upstream

Before a service goes live, each upstream host serves \`/.well-known/servicerouter.json\` with the service's token. \`GET ${apiUrl}/v1/services/<id>/status\` shows what's missing. A change of payout address waits until every host lists its confirmation token. This check is arriving: follow the status endpoint's answer.

## 6. Get paid

Earnings are paid out monthly, on the 1st, in USDM on Cardano to the payout address, once they reach the minimum. Agents find the service in the catalog, in its generated \`llms.txt\`, Agent Skill, and OpenAPI document, and in the x402 Bazaar unless \`discoverable\` is \`false\`.
`,
};

export const platformSkills: readonly PlatformSkill[] = [buyer, seller];

/** A skill as its SKILL.md file: frontmatter, then the body. */
export const skillDocument = (skill: PlatformSkill, settings: SiteSettings): string =>
  `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body(settings)}`;

export const findSkill = (name: string): PlatformSkill | undefined => platformSkills.find(skill => skill.name === name);
