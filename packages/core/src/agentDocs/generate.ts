import { createHash } from 'node:crypto';

import { formatUsd, isRecord, type MicroUsd } from '@servicerouter/common';

import type { PlatformConfig } from '../platform/config.js';
import { bazaarMetadata, operationObject, withoutKeys } from '../service/discovery.js';
import type { ServiceConfigDocument } from '../service/document.js';
import { canonicalJson } from '../service/registry.js';
import type { RuntimeOperation, ServiceRuntime } from '../service/runtime.js';

// Bump when the generated documents change for the same inputs, so stored ones are made again (AD-4)
export const agentDocsGeneratorVersion = 1;

export const serviceDocumentKinds = ['openapi.json', 'llms.txt', 'skill.md', 'bazaar.json'] as const;
export type ServiceDocumentKind = typeof serviceDocumentKinds[number];

export type PaymentMethod = 'credits' | 'x402' | 'mpp';

export interface ServiceDocumentsInput {
  readonly config: ServiceConfigDocument;
  readonly openapiDocuments: ReadonlyMap<string, unknown>;
  readonly runtime: ServiceRuntime;
  readonly platform: PlatformConfig;
}

export interface GeneratedDocument {
  readonly content: string;
  // A strong ETag of the content (AD-4)
  readonly etag: string;
}

export type ServiceDocuments = Readonly<Record<ServiceDocumentKind, GeneratedDocument>>;

interface DocOperation {
  readonly runtime: RuntimeOperation;
  // The seller's operation object, without what must not reach agents
  readonly object: Record<string, unknown>;
  readonly methods: readonly PaymentMethod[];
}

// Components that describe the seller's own credentials
const droppedComponentKeys = new Set(['securitySchemes']);

const etagOf = (content: string): string => `"${createHash('sha256').update(content).digest('base64url').slice(0, 27)}"`;

const document = (content: string): GeneratedDocument => ({ content, etag: etagOf(content) });

/** Every method that can pay this price (AD-2): credits for any paid call, x402 and MPP when an asset's minimum allows. */
export const paymentMethodsFor = (price: MicroUsd, platform: PlatformConfig): readonly PaymentMethod[] => {
  if (price === 0n)
    return [];

  const facilitatorNetworks = new Set(platform.facilitators.filter(facilitator => facilitator.enabled).flatMap(facilitator => facilitator.networks));
  const affordable = platform.assets.filter(asset => asset.minPrice <= price);
  const x402 = affordable.some(asset => asset.network.chain !== 'tempo' && facilitatorNetworks.has(asset.network.id));
  const mpp = platform.mpp.enabled && affordable.some(asset => asset.network.chain === 'tempo' && asset.network.id === platform.mpp.network.id);

  return ['credits', ...x402 ? ['x402' as const] : [], ...mpp ? ['mpp' as const] : []];
};

/** The seller's OpenAPI source of an upstream: its fetched document, or its inline `paths`. */
const sourceOf = (input: ServiceDocumentsInput, operation: RuntimeOperation): { paths: unknown; components: unknown } => {
  const upstream = input.config.upstreams.find(candidate => candidate.name !== undefined
    ? candidate.name === operation.upstream.name
    : candidate.baseUrl.replace(/\/+$/, '') === operation.upstream.baseUrl);
  if (upstream?.openapi !== undefined) {
    const fetched = input.openapiDocuments.get(upstream.openapi);

    return isRecord(fetched) ? { paths: fetched['paths'], components: fetched['components'] } : { paths: undefined, components: undefined };
  }

  return { paths: upstream?.paths, components: undefined };
};

const operationsOf = (input: ServiceDocumentsInput): readonly DocOperation[] => input.runtime.operations
  .filter(operation => operation.enabled)
  .map(operation => ({
    runtime: operation,
    object: operationObject(sourceOf(input, operation).paths, operation),
    methods: paymentMethodsFor(operation.price, input.platform),
  }));

const payUrlOf = (input: ServiceDocumentsInput): string => `${input.platform.urls.pay}/service/${input.config.service.id}`;

/** AD-1: OpenAPI 3.1 with the pay URL as its server, a price per operation, and the payment key as bearer. */
const openApiDocument = (input: ServiceDocumentsInput, operations: readonly DocOperation[]): string => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const { runtime, object, methods } of operations) {
    paths[runtime.path] = {
      ...paths[runtime.path],
      [runtime.method]: {
        ...object,
        ...runtime.docs.operationId === undefined ? {} : { operationId: runtime.routeKey ?? runtime.docs.operationId },
        ...object['responses'] === undefined ? { responses: { 200: { description: 'OK' } } } : {},
        'x-payment-info': { price: formatUsd(runtime.price), currency: 'USD', methods },
      },
    };
  }
  // The components the operations may reference, without the seller's security schemes
  const components: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const source = sourceOf(input, operation.runtime).components;
    if (!isRecord(source))
      continue;
    for (const [group, entries] of Object.entries(withoutKeys(source, droppedComponentKeys))) {
      if (isRecord(entries))
        components[group] = { ...components[group], ...entries };
    }
  }
  const { service } = input.config;
  const result = {
    openapi: '3.1.0',
    info: {
      title: service.title,
      ...service.summary === undefined ? {} : { summary: service.summary },
      description: service.description,
      version: String(input.runtime.revision),
    },
    servers: [{ url: payUrlOf(input), description: 'Service Router: pay per call with a payment key, x402, or MPP' }],
    security: [{ paymentKey: [] }],
    paths,
    components: {
      ...components,
      securitySchemes: {
        paymentKey: {
          type: 'http',
          scheme: 'bearer',
          description: `A Service Router payment key (${input.platform.keyPrefixes.payment}…). Without one, the 402 answer lists x402 and MPP options.`,
        },
      },
    },
  };

  return `${JSON.stringify(result, null, 2)}\n`;
};

const methodNames: Readonly<Record<PaymentMethod, string>> = { credits: 'credits (payment key)', x402: 'x402', mpp: 'MPP' };

const priceText = (price: MicroUsd): string => price === 0n ? 'free' : `$${formatUsd(price)}`;

const routeTable = (operations: readonly DocOperation[]): string => [
  '| Route | What it does | Price | Pay with |',
  '|---|---|---|---|',
  ...operations.map(({ runtime, methods }) => {
    const what = (runtime.docs.summary ?? runtime.docs.description ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

    return `| \`${runtime.method.toUpperCase()} ${runtime.path}\` | ${what} | ${priceText(runtime.price)} | ${methods.map(method => methodNames[method]).join(', ') || 'no payment'} |`;
  }),
].join('\n');

const example = (input: ServiceDocumentsInput, operations: readonly DocOperation[]): string => {
  const paid = operations.find(operation => operation.runtime.price > 0n) ?? operations[0];
  if (!paid)
    return '';

  const path = paid.runtime.path.replace(/\{([^}]+)\}/g, (_match, name: string) => `<${name}>`);
  const body = paid.runtime.method === 'get' || paid.runtime.method === 'head' || paid.runtime.method === 'delete'
    ? ''
    : ' \\\n  -H "Content-Type: application/json" -d \'{…}\'';

  return [
    '```sh',
    `curl -X ${paid.runtime.method.toUpperCase()} "${payUrlOf(input)}${path}" \\`,
    `  -H "Authorization: Bearer $SERVICEROUTER_PAYMENT_KEY"${body}`,
    '```',
  ].join('\n');
};

const howToPay = (input: ServiceDocumentsInput): string => [
  `1. **Credits (default).** Send a Service Router payment key as \`Authorization: Bearer ${input.platform.keyPrefixes.payment}…\`. A paid answer carries \`Servicerouter-Receipt\`. The guide at ${input.platform.urls.website}/llms.txt shows how to get an account and a key, with the user's consent.`,
  '2. **x402.** Without a key, the `402` answer carries `PAYMENT-REQUIRED` with x402 options. Sign one and retry with `PAYMENT-SIGNATURE`.',
  '3. **MPP.** The same `402` carries `WWW-Authenticate: Payment` with a Tempo charge. Retry with `Authorization: Payment …`.',
  '',
  'Only billable answers are charged: a failed call costs nothing.',
].join('\n');

/** AD-2: the service's llms.txt. */
const llmsText = (input: ServiceDocumentsInput, operations: readonly DocOperation[]): string => {
  const { service } = input.config;
  const docsBase = `${input.platform.urls.api}/v1/services/${service.id}`;

  return `${[
    `# ${service.title}`,
    '',
    `> ${service.summary ?? service.description.split('\n')[0]}. Called through Service Router at ${payUrlOf(input)}, paid per call.`,
    '',
    service.description.trim(),
    '',
    '## Routes',
    '',
    routeTable(operations),
    '',
    '## How to pay',
    '',
    howToPay(input),
    '',
    '## Call it',
    '',
    example(input, operations),
    '',
    '## Documents',
    '',
    `- [OpenAPI](${docsBase}/openapi.json): every route, with its price in \`x-payment-info\`. Its server is the pay URL.`,
    `- [Agent Skill](${docsBase}/skill.md)`,
    `- [Service Router guide](${input.platform.urls.website}/llms.txt)`,
  ].join('\n')}\n`;
};

/** AD-2: the service's Agent Skill. */
const skill = (input: ServiceDocumentsInput, operations: readonly DocOperation[]): string => {
  const { service } = input.config;
  const description = `${service.summary ?? service.title}. Call ${service.title} through Service Router, paid per call with a payment key, x402, or MPP.`
    .replaceAll('\n', ' ');

  return `${[
    '---',
    `name: ${service.id}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    `# ${service.title}`,
    '',
    service.description.trim(),
    '',
    `Base URL: \`${payUrlOf(input)}\`. Add the route's path to it.`,
    '',
    '## Routes',
    '',
    routeTable(operations),
    '',
    '## How to pay',
    '',
    howToPay(input),
    '',
    '## Example',
    '',
    example(input, operations),
    '',
    `The OpenAPI document at ${input.platform.urls.api}/v1/services/${service.id}/openapi.json describes each route's parameters and answers.`,
  ].join('\n')}\n`;
};

/**
 * AD-3: x402 Bazaar discovery metadata per paid operation: a description, the input (parameters and
 * body), the output schema, and an example where the seller's document has one. Stored with the
 * documents as the seller wrote it. The compiler puts the same entries in the runtime, with local
 * references inlined, and the x402 challenge carries them (PR-7).
 */
const bazaar = (input: ServiceDocumentsInput, operations: readonly DocOperation[]): string => {
  const entries = operations.filter(operation => operation.runtime.price > 0n).map(({ runtime, object }) => bazaarMetadata({
    resource: `${payUrlOf(input)}${runtime.path}`,
    method: runtime.method,
    description: runtime.docs.description ?? runtime.docs.summary ?? input.config.service.title,
    object,
  }));

  return `${JSON.stringify({ service: input.config.service.id, revision: input.runtime.revision, operations: entries }, null, 2)}\n`;
};

/** The hash of everything the documents are made from, so a stored set is made again when any of it changes (AD-4). */
export const serviceDocumentsInputHash = (input: ServiceDocumentsInput): string => createHash('sha256').update(canonicalJson({
  version: agentDocsGeneratorVersion,
  config: input.config,
  openapi: Object.fromEntries(input.openapiDocuments),
  revision: input.runtime.revision,
  urls: input.platform.urls,
  keyPrefix: input.platform.keyPrefixes.payment,
  methods: input.runtime.operations.map(operation => paymentMethodsFor(operation.price, input.platform)),
})).digest('hex');

/**
 * A service's agent documents (AD-1 to AD-3), from its active revision. Deterministic: the same inputs
 * give byte-identical documents (AD-6). No upstream URL and no seller credential appears.
 */
export const generateServiceDocuments = (input: ServiceDocumentsInput): ServiceDocuments => {
  const operations = operationsOf(input);

  return {
    'openapi.json': document(openApiDocument(input, operations)),
    'llms.txt': document(llmsText(input, operations)),
    'skill.md': document(skill(input, operations)),
    'bazaar.json': document(bazaar(input, operations)),
  };
};
