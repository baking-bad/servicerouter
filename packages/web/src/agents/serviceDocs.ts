import type { CatalogService } from '../api/types';
import { displayUsd } from '../money';
import { servicePrompt } from './prompts';

// A service's agent documents (AD-1, AD-2), built from its catalog entry. The website serves them while
// the Platform API's (step 10) are sample data (WB-10). Like AD-1's: the server is the pay URL, every
// operation has its price, the payment key is the security scheme, and no upstream URL appears.

const methodNames: Readonly<Record<string, string>> = { credits: 'credits (payment key)', x402: 'x402', mpp: 'MPP' };

const pathParameters = (path: string): readonly string[] => [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]!);

/** AD-1: OpenAPI 3.1 with the pay URL as its server and the price of each operation. */
export const serviceOpenApi = (service: CatalogService): Record<string, unknown> => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of service.routes) {
    const parameters = pathParameters(route.path).map(name => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
    paths[route.path] = {
      ...paths[route.path],
      [route.method.toLowerCase()]: {
        operationId: route.key,
        summary: route.summary,
        ...(parameters.length > 0 ? { parameters } : {}),
        'x-payment-info': { price: route.price, currency: 'USD', methods: route.methods },
        responses: {
          200: { description: 'OK. Paid calls carry Servicerouter-Receipt, PAYMENT-RESPONSE, or Payment-Receipt.' },
          402: { description: 'Payment required: the answer lists credits, x402, and MPP options.' },
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: { title: service.title, summary: service.summary, description: service.description, version: '1' },
    servers: [{ url: service.payUrl }],
    security: [{ paymentKey: [] }],
    components: {
      securitySchemes: {
        paymentKey: { type: 'http', scheme: 'bearer', description: 'A Service Router payment key, such as sr_live_…. Or pay per call with x402 or MPP.' },
      },
    },
    paths,
  };
};

const routeTable = (service: CatalogService): string => [
  '| Route | Price | Pay with |',
  '|---|---|---|',
  ...service.routes.map(route => `| \`${route.method} ${route.path}\` (${route.summary}) | ${displayUsd(route.price)} | ${route.methods.map(method => methodNames[method] ?? method).join(', ')} |`),
].join('\n');

const callExample = (service: CatalogService): string => {
  const route = service.routes[0];
  if (!route)
    return '';
  const path = route.path.replace(/\{([^}]+)\}/g, (_match, name: string) => `<${name}>`);
  const body = route.method === 'GET' || route.method === 'HEAD' ? '' : ` \\\n  -H "Content-Type: application/json" -d '{…}'`;

  return `\`\`\`sh\ncurl -X ${route.method} ${service.payUrl}${path} \\\n  -H "Authorization: Bearer $SERVICEROUTER_PAYMENT_KEY"${body}\n\`\`\``;
};

/** AD-2: the service's llms.txt. */
export const serviceLlms = (service: CatalogService, siteUrl: string): string => `# ${service.title}

> ${service.summary}. Called through Service Router at ${service.payUrl}, paid per call.

${service.description}

## Routes

${routeTable(service)}

Only \`2xx\` answers are charged.

## Call it

${callExample(service)}

Pay with a Service Router payment key (credits): ${siteUrl}/llms.txt shows how to get one. Without an account, the \`402\` answer lists x402 and MPP options.

## Documents

- [OpenAPI](${service.docs.openapi}): every operation, with its price in \`x-payment-info\`.
- [Agent Skill](${service.docs.skill})
- [Service page](${siteUrl}/discover/${service.id}.md)
`;

/** AD-2: the service's Agent Skill. */
export const serviceSkill = (service: CatalogService, siteUrl: string): string => `---
name: ${service.id}
description: Call the ${service.title} API through Service Router, paying per call. ${service.summary}. Use when the user needs ${service.tags.slice(0, 3).join(', ') || service.category}.
---

# ${service.title}

${service.description}

Base URL: \`${service.payUrl}\`. Send \`Authorization: Bearer $SERVICEROUTER_PAYMENT_KEY\`. No payment key yet: follow ${siteUrl}/llms.txt with the user's consent, or pay per call with x402 or MPP from the \`402\` answer.

${routeTable(service)}

${callExample(service)}

- Only \`2xx\` answers are charged. Each carries a receipt header.
- \`402\` with a code such as \`insufficient_balance\` or \`key_budget_exceeded\`: ask the user before topping up or raising limits.
- OpenAPI: ${service.docs.openapi}

Prompt for the user to give an agent: "${servicePrompt({ title: service.title, llms: service.docs.llms })}"
`;
