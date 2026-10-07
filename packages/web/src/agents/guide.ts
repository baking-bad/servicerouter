import type { SiteSettings } from '../config';

// The platform guide for first-time buyers (AD-5), served at /llms.txt in the llms.txt format: a title,
// a summary in a quote, then sections of text and links. Absolute URLs come from the settings.

export const buyerSkillPath = '/skills/servicerouter-buyer/SKILL.md';
export const sellerSkillPath = '/skills/servicerouter-seller/SKILL.md';

/** `/llms.txt`: how the platform works, and how an agent starts paying for calls, with its user's consent. */
export const platformGuide = ({ siteUrl, apiUrl, payUrl }: SiteSettings): string => `# Service Router

> Pay-per-call access to APIs for AI agents. One account and one payment key pay any service listed here, with credits: a prepaid USD balance, with no on-chain fee per call. Agents without an account can pay each call with x402 or MPP instead. Sellers list an API and get paid per call.

Every service is called at \`${payUrl}/service/<service-id>/<path>\`. A call without payment answers \`402 Payment Required\`, listing every way to pay: credits, x402 (USDC on Base and Solana, USDM on Cardano), and MPP (stablecoins on Tempo). Credits are the default: sub-cent prices work, and nothing is signed per call.

## Start with credits

Ask your user before each of these steps.

1. Sign up: \`curl -X POST ${apiUrl}/v1/accounts\`. The answer has a \`masterKey\`. Save it at once in a file only your user can read (\`chmod 600\`), and never paste it into a chat, a log, or a URL.
2. Tell your user that a lost master key can't be recovered: there is no email recovery yet. Ask them to keep a copy somewhere safe.
3. Create a payment key with limits your user agrees to, and use only that key for calls. Keep the master key with your user:

   \`\`\`sh
   curl -X POST ${apiUrl}/v1/keys \\
     -H "Authorization: Bearer $SERVICEROUTER_MASTER_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{"label": "my-agent", "dailyBudget": "5", "maxPrice": "0.05"}'
   \`\`\`

   The answer's \`key\` is shown once. Limits: \`dailyBudget\` (USD a day, $5 by default), \`allowance\` (USD in total), \`maxPrice\` (USD per call), and \`expiresAt\`.
4. Top up: \`GET ${apiUrl}/v1/account\` gives a \`topupUrl\`. Give it to your user: it shows the deposit address (USDM on Cardano). Start calling once the deposit is credited. While \`topupUrl\` is null, deposits aren't open for the account yet: pay with x402 or MPP instead.

## Call a service

\`\`\`sh
curl ${payUrl}/service/<service-id>/<path> -H "Authorization: Bearer $SERVICEROUTER_PAYMENT_KEY"
\`\`\`

- A paid answer carries \`Servicerouter-Receipt: id="pay_…", amount="0.001", currency="USD"\`. You pay only for \`2xx\` answers.
- \`GET ${payUrl}/_/key\` with the payment key shows its limits, what it spent, and what's left.
- \`${apiUrl}/v1/balance\` and \`${apiUrl}/v1/payments\` take the master key.
- Errors are \`{"error": {"code", "message"}}\`: \`insufficient_balance\`, \`key_budget_exceeded\`, \`key_allowance_exceeded\`, \`key_price_limit\` (\`402\`); \`invalid_key\`, \`wrong_key_type\` for a master key (\`401\`); \`rate_limited\` (\`429\`, with \`Retry-After\`); \`upstream_unavailable\` (\`503\`, not charged).

## Pay without an account

- **x402:** the \`402\` has a \`PAYMENT-REQUIRED\` header (x402 v2). Sign one of its options with an x402 client and retry with \`PAYMENT-SIGNATURE\`. The answer carries \`PAYMENT-RESPONSE\`.
- **MPP:** the \`402\` has a \`WWW-Authenticate: Payment\` Tempo charge. Sign it in pull mode with an MPP client, such as \`mppx\`, and retry with \`Authorization: Payment …\`. The answer carries \`Payment-Receipt\`. Send the retry at once: the signed transaction expires within about 25 seconds.

Either way, the payment settles only after a \`2xx\` answer. A failed call costs nothing.

## Pay any x402 or MPP API

Put \`${payUrl}/\` in front of a paid API's URL, without \`https://\`: \`${payUrl}/api.example.com/v1/pools\` calls \`https://api.example.com/v1/pools\`. The API doesn't need to be listed here. Service Router pays it in its own protocol, x402 on Base or Solana, or MPP on Tempo, and returns its answer.

You pay Service Router the quote, the API's price plus any routing fee, in any way above: a payment key in one request, or the options of its \`402\`, such as x402 with USDM on Cardano. \`GET ${payUrl}/_/check?url=<link>\` quotes a link without paying. A failed call costs nothing.

## Find services

- [The catalog](${siteUrl}/discover.md): every service, with prices, payment methods, and stats. Filter with \`?category=\`, \`q=\`, \`method=\`, \`maxPrice=\`, and \`sort=\`.
- Each service has its own instructions: \`llms.txt\`, an Agent Skill, and an OpenAPI document whose server is its pay URL. Its page links them: \`${siteUrl}/discover/<service-id>.md\`.

## Skills

- [Buyer skill](${siteUrl}${buyerSkillPath}): everything above, step by step.
- [Seller skill](${siteUrl}${sellerSkillPath}): list an API and get paid per call, with plain HTTP calls.

## Optional

- [Everything in one file](${siteUrl}/llms-full.txt): this guide, both skills, and the catalog.
- [For agents](${siteUrl}/agents.md): what agents can read here.
`;
