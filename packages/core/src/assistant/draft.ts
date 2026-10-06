import { stringify } from 'yaml';

import { isRecord, usdAmountPattern, type ValidationIssue } from '@servicerouter/common';

import type { PlatformConfig } from '../platform/config.js';
import { operationsFromDocument } from '../service/openapi.js';
import { checkAndCompileParsedServiceConfig, parseServiceConfig } from '../service/validate.js';

/** An operation of the seller's document, as the assistant shows it to the model (CA-2). */
export interface DraftOperation {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string | undefined;
}

/** What needs judgment (CA-2): filled by a model, never trusted as is. */
export interface JudgedFields {
  readonly summary: string;
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  // USD per call, by route key
  readonly prices: Readonly<Record<string, string>>;
}

/**
 * Port: the model that fills in the fields that need judgment (CA-2). The document is untrusted
 * input (CA-4): an adapter passes it as data, never as instructions, and its answer is checked here.
 */
export interface LlmDrafter {
  fill(input: {
    readonly title: string;
    readonly description: string | undefined;
    readonly operations: readonly DraftOperation[];
    readonly categories: readonly { readonly id: string; readonly title: string }[];
  }): Promise<JudgedFields>;
}

// Without a model, the draft says so and leaves these for the seller to review
export const defaultDraftPrice = '0.001';

/** A drafter that needs no model: the document's own words, the first category, and the default price. For review. */
export const createDefaultDrafter = (): LlmDrafter => ({
  fill: async ({ title, description, operations, categories }) => ({
    summary: title,
    description: description ?? title,
    category: categories[0]?.id ?? '',
    tags: [],
    prices: Object.fromEntries(operations.map(operation => [operation.key, defaultDraftPrice])),
  }),
});

/** The mechanical part of a draft (CA-2), from the seller's document alone. */
export interface MechanicalDraft {
  readonly title: string;
  readonly description: string | undefined;
  readonly upstream: { readonly baseUrl: string; readonly openapi: string; readonly auth?: readonly string[] };
  readonly credentials: Readonly<Record<string, Record<string, string>>>;
  readonly operations: readonly DraftOperation[];
  // What the mapping couldn't carry over, such as OAuth schemes
  readonly notes: readonly string[];
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : undefined;

const secretNameOf = (scheme: string): string => scheme.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'api';

/**
 * CA-2's mechanical mapping: `servers[0]` → the upstream's base URL (resolved against the document's
 * link), `securitySchemes` → credentials with a secret named after each scheme, and the operations →
 * route keys. Nothing here asks a model.
 */
export const mapOpenApi = (document: unknown, link: string): MechanicalDraft => {
  const notes: string[] = [];
  const root = isRecord(document) ? document : {};
  const info = isRecord(root['info']) ? root['info'] : {};
  const servers = Array.isArray(root['servers']) ? root['servers'] : [];
  const server = servers.find(isRecord);
  let baseUrl: string;
  try {
    baseUrl = new URL(typeof server?.['url'] === 'string' ? server['url'] : '/', link).href.replace(/\/+$/, '');
  }
  catch {
    baseUrl = new URL('/', link).href.replace(/\/+$/, '');
    notes.push('servers[0].url isn\'t a URL: the document\'s origin is the base URL');
  }
  if (!server)
    notes.push('The document has no servers: the document\'s origin is the base URL');

  const components = isRecord(root['components']) ? root['components'] : {};
  const schemes = isRecord(components['securitySchemes']) ? components['securitySchemes'] : {};
  const credentials: Record<string, Record<string, string>> = {};
  for (const [name, scheme] of Object.entries(schemes)) {
    if (!isRecord(scheme))
      continue;
    const secret = secretNameOf(name);
    if (scheme['type'] === 'http' && (scheme['scheme'] === 'bearer' || scheme['scheme'] === 'basic'))
      credentials[secret] = { type: 'http', scheme: scheme['scheme'], secret };
    else if (scheme['type'] === 'apiKey' && typeof scheme['name'] === 'string' && ['header', 'query', 'cookie'].includes(String(scheme['in'])))
      credentials[secret] = { type: 'apiKey', in: String(scheme['in']), name: scheme['name'], secret };
    else
      notes.push(`The security scheme ${JSON.stringify(name)} isn't one the platform sends: add its credential by hand`);
  }

  const parsed = operationsFromDocument(document);
  const operations = parsed.ok
    ? parsed.operations.filter(operation => operation.operationId !== undefined).map(operation => ({
      key: operation.operationId!,
      method: operation.method.toUpperCase(),
      path: operation.path,
      summary: text(operation.summary ?? operation.description, 200),
    }))
    : [];
  if (parsed.ok && operations.length < parsed.operations.length)
    notes.push('Operations without an operationId get no route key and the default price');

  return {
    title: text(info['title'], 60) ?? 'My API',
    description: text(info['description'], 2_000),
    upstream: { baseUrl, openapi: link, ...Object.keys(credentials).length > 0 ? { auth: Object.keys(credentials) } : {} },
    credentials,
    operations,
    notes,
  };
};

const serviceIdOf = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'my-api';

const tagPattern = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Keeps what the model said only where it fits (CA-4): a listed category, valid prices, short plain text. */
const sanitize = (judged: JudgedFields, mechanical: MechanicalDraft, platform: PlatformConfig): JudgedFields & { readonly notes: readonly string[] } => {
  const notes: string[] = [];
  const categories = platform.categories.map(category => category.id);
  let category = typeof judged.category === 'string' && categories.includes(judged.category) ? judged.category : categories[0] ?? '';
  if (category !== judged.category) {
    notes.push('The suggested category isn\'t in the platform list: review the category');
    category = categories[0] ?? '';
  }
  const prices: Record<string, string> = {};
  for (const operation of mechanical.operations) {
    const price = judged.prices?.[operation.key];
    prices[operation.key] = typeof price === 'string' && new RegExp(usdAmountPattern).test(price) ? price : defaultDraftPrice;
  }

  return {
    summary: text(judged.summary, 120) ?? mechanical.title,
    description: text(judged.description, 2_000) ?? mechanical.description ?? mechanical.title,
    category,
    tags: (Array.isArray(judged.tags) ? judged.tags : []).map(tag => String(tag).toLowerCase()).filter(tag => tagPattern.test(tag)).slice(0, 10),
    prices,
    notes,
  };
};

export interface Draft {
  // YAML, ready to edit and submit with PUT /v1/services/{id}
  readonly yaml: string;
  readonly serviceId: string;
  readonly warnings: readonly ValidationIssue[];
  readonly notes: readonly string[];
}

/**
 * A draft config (CA-1 to CA-4): the mechanical mapping, the model's judgment checked and bounded, and
 * the same validation as a submit (SR-2) before it is returned. Returns the validation's errors
 * instead when the draft doesn't pass, which a correct mapping never causes.
 */
export const draftServiceConfig = async ({ document, link, platform, drafter, serviceId, payoutAddress }: {
  readonly document: unknown;
  readonly link: string;
  readonly platform: PlatformConfig;
  readonly drafter: LlmDrafter;
  readonly serviceId?: string;
  // A placeholder the seller replaces, valid for the payout asset's network
  readonly payoutAddress: string;
}): Promise<{ readonly ok: true; readonly draft: Draft } | { readonly ok: false; readonly errors: readonly ValidationIssue[] }> => {
  const mechanical = mapOpenApi(document, link);
  const judged = sanitize(await drafter.fill({
    title: mechanical.title,
    description: mechanical.description,
    operations: mechanical.operations,
    categories: platform.categories.map(category => ({ id: category.id, title: category.title })),
  }), mechanical, platform);
  const id = serviceId ?? serviceIdOf(mechanical.title);
  const prices = Object.values(judged.prices);
  // The most common price is the default; routes that differ get their own
  const defaultPrice = prices.sort((left, right) => prices.filter(price => price === right).length - prices.filter(price => price === left).length)[0] ?? defaultDraftPrice;
  const routes = Object.fromEntries(Object.entries(judged.prices).filter(([, price]) => price !== defaultPrice).map(([key, price]) => [key, { payment: { amount: price } }]));
  const config = {
    servicerouter: { version: '1' },
    service: {
      id,
      title: mechanical.title,
      summary: judged.summary,
      description: judged.description,
      category: judged.category,
      ...judged.tags.length > 0 ? { tags: [...judged.tags] } : {},
    },
    payouts: { default: { asset: platform.payouts.assets[0]!, address: payoutAddress } },
    payments: { default: { amount: defaultPrice } },
    upstreams: [{ baseUrl: mechanical.upstream.baseUrl, name: 'main', openapi: mechanical.upstream.openapi, ...mechanical.upstream.auth ? { auth: [...mechanical.upstream.auth] } : {} }],
    ...Object.keys(routes).length > 0 ? { routes } : {},
    ...Object.keys(mechanical.credentials).length > 0 ? { credentials: mechanical.credentials } : {},
  };
  const yaml = `# A draft from ${link}. Review every field, replace the payout address, and send each credential's secret with the submit.\n${stringify(config, { lineWidth: 0 })}`;

  // CA-3: the same validation as a submit, secrets still to come
  const parsed = parseServiceConfig(yaml);
  if (!parsed.ok)
    return { ok: false, errors: parsed.errors };
  const checked = checkAndCompileParsedServiceConfig(parsed.parsed, {
    platform, openapiDocuments: new Map([[link, document]]), secretNames: new Set(), storedSecretOrigins: new Map(), revision: 1, state: 'pending',
  });
  if (!checked.ok)
    return { ok: false, errors: checked.errors };

  return { ok: true, draft: { yaml, serviceId: id, warnings: checked.warnings, notes: [...mechanical.notes, ...judged.notes] } };
};
