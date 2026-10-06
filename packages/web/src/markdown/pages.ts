import { buyerSkillPath, sellerSkillPath } from '../agents/guide';
import { platformPrompt, sellerPrompt, servicePrompt } from '../agents/prompts';
import type { CatalogItem, CatalogPage, CatalogQuery, CatalogService, Topup } from '../api/types';
import { catalogQueryParams } from '../catalog/query';
import type { SiteSettings } from '../config';
import { buyerSteps, methodInfo, pitch, sampleNotice, sellerSteps, siteName, tagline } from '../content';
import { compactCount, latency, percent, shortDate } from '../format';
import { displayUsd } from '../money';

// The Markdown version of each public page (WB-11): the same content as the HTML, for agents.

const sampleLine = (sample: boolean): string => sample ? `\n> ${sampleNotice}\n` : '';

const methodList = (item: Pick<CatalogItem, 'methods'>): string => item.methods.map(method => methodInfo[method].short).join(', ');

const serviceLine = (settings: SiteSettings, item: CatalogItem): string =>
  `- [${item.title}](${settings.siteUrl}/discover/${item.id}.md): ${item.summary}. From ${displayUsd(item.priceFrom)} a call; ${methodList(item)}; ${compactCount(item.stats.calls30d)} calls in 30 days, ${percent(item.stats.successRate)} success.`;

/** `/index.md`: the landing page. */
export const landingMarkdown = (settings: SiteSettings, popular: { readonly services: readonly CatalogItem[]; readonly sample: boolean }): string => `# ${siteName}: ${tagline}

${pitch}

Give this to your agent:

> ${platformPrompt(settings)}

## For buyers and their agents

${buyerSteps.map((step, index) => `${index + 1}. **${step.title}.** ${step.text}`).join('\n')}

Read [the guide](${settings.siteUrl}/llms.txt) or the [buyer skill](${settings.siteUrl}${buyerSkillPath}).

## For sellers

${sellerSteps.map((step, index) => `${index + 1}. **${step.title}.** ${step.text}`).join('\n')}

> ${sellerPrompt(settings)}

## Payment methods

${(['credits', 'x402', 'mpp'] as const).map(method => `- **${methodInfo[method].title}:** ${methodInfo[method].text} ${methodInfo[method].networks}.`).join('\n')}

## Popular services
${sampleLine(popular.sample)}
${popular.services.map(item => serviceLine(settings, item)).join('\n')}

[Every service](${settings.siteUrl}/discover.md)
`;

/** `/discover.md`: the catalog, with the same query as the page. */
export const discoverMarkdown = (settings: SiteSettings, page: CatalogPage, query: CatalogQuery, sample: boolean): string => {
  const next = page.next === null ? '' : `\n[Next page](${settings.siteUrl}/discover.md?${catalogQueryParams(query, { cursor: page.next }).toString()})\n`;
  const active = catalogQueryParams(query, { cursor: undefined }).toString();

  return `# Discover services

Every service listed on ${siteName}, called at \`${settings.payUrl}/service/<id>/<path>\` and paid per call.${active ? ` Filtered by \`${active}\`.` : ''}

Filter with \`?category=\`, \`q=\`, \`method=\` (credits, x402, mpp), \`maxPrice=\` (USD), and \`sort=\` (popular, price, newest, success).
${sampleLine(sample)}
## Categories

${page.categories.filter(category => category.count > 0).map(category => `- [${category.title}](${settings.siteUrl}/discover.md?category=${category.id}) (\`${category.id}\`): ${category.count}`).join('\n')}

## Services

${page.services.length === 0 ? 'No service matches.' : page.services.map(item => serviceLine(settings, item)).join('\n')}
${next}`;
};

/** `/discover/<id>.md`: one service. */
export const serviceMarkdown = (settings: SiteSettings, service: CatalogService, sample: boolean): string => `# ${service.title}

> ${service.summary}
${sampleLine(sample)}
${service.description}

- Category: \`${service.category}\`. Tags: ${service.tags.join(', ')}.
- Pay URL: \`${service.payUrl}\`
- Pay with: ${methodList(service)}.
- Last 30 days: ${compactCount(service.stats.calls30d)} calls, ${percent(service.stats.successRate)} success, ${latency(service.stats.p50Ms)} median, ${latency(service.stats.p95Ms)} p95.

## Routes

| Route | Summary | Price | Pay with | Calls (30 days) |
|---|---|---|---|---|
${service.routes.map(route => `| \`${route.method} ${route.path}\` | ${route.summary} | ${displayUsd(route.price)} | ${route.methods.map(method => methodInfo[method].short).join(', ')} | ${compactCount(route.stats.calls30d)} |`).join('\n')}

Only \`2xx\` answers are charged.

## For agents

- [llms.txt](${service.docs.llms})
- [Agent Skill](${service.docs.skill})
- [OpenAPI](${service.docs.openapi})

> ${servicePrompt({ title: service.title, llms: service.docs.llms })}

## Links

${[service.links.homepage && `- Homepage: ${service.links.homepage}`, service.links.docs && `- Docs: ${service.links.docs}`, service.contact.url && `- Support: ${service.contact.url}`].filter(Boolean).join('\n')}
- Updated ${shortDate(service.updatedAt)}
`;

/** `/agents.md`: what agents can read here. */
export const agentsMarkdown = (settings: SiteSettings): string => `# ${siteName} for agents

Everything here is plain text an agent can read: no SDK, no MCP server, plain HTTP.

> ${platformPrompt(settings)}

## Read first

- [llms.txt](${settings.siteUrl}/llms.txt): the platform guide. Sign up, create a payment key with limits, top up, and call any service.
- [llms-full.txt](${settings.siteUrl}/llms-full.txt): the guide, both skills, and the whole catalog in one file.

## Agent Skills

- [Buyer skill](${settings.siteUrl}${buyerSkillPath}): pay for API calls with credits, x402, or MPP.
- [Seller skill](${settings.siteUrl}${sellerSkillPath}): list an API and get paid per call.

## Every page in Markdown

Add \`.md\` to a page's URL, such as [${settings.siteUrl}/discover.md](${settings.siteUrl}/discover.md), or ask for it with \`Accept: text/markdown\`.

## Each service's documents

Every service links its own \`llms.txt\`, Agent Skill, and OpenAPI document. The OpenAPI server is the service's pay URL, so an agent can take it as it is.

## Paying

${(['credits', 'x402', 'mpp'] as const).map(method => `- **${methodInfo[method].title}:** ${methodInfo[method].text}`).join('\n')}

## Selling

> ${sellerPrompt(settings)}
`;

/** `/topup/<token>.md`: where to send a deposit. */
export const topupMarkdown = (topup: Topup, sample: boolean): string => `# Top up your credits
${sampleLine(sample)}${sample ? '> Never send funds to this sample address.\n' : ''}
Send **${topup.asset.symbol}** on **${topup.asset.networkTitle}** (\`${topup.asset.network}\`) to:

\`\`\`
${topup.address}
\`\`\`

${topup.asset.symbol} is credited 1:1 in USD once the deposit confirms. Send nothing else: other assets aren't credited.

## Deposits

${topup.deposits.length === 0 ? 'None yet.' : ['| Seen | Amount | Status | Confirmations | Transaction |', '|---|---|---|---|---|', ...topup.deposits.map(deposit => `| ${shortDate(deposit.seenAt)} | ${displayUsd(deposit.amount)} | ${deposit.status} | ${deposit.confirmations}/${deposit.confirmationsRequired} | \`${deposit.transactionHash}\` |`)].join('\n')}
`;
