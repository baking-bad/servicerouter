import { isRecord } from '@servicerouter/common';

import type { HttpMethod } from './document.js';

// AD-3: x402 Bazaar discovery metadata, one entry per paid operation. The agent docs store it as
// `bazaar.json`; the compiler puts the same entry in the runtime, which the x402 challenge carries (PR-7).

/** A parameter of an operation, as the seller's document declares it. */
export interface BazaarParameter {
  readonly name: unknown;
  readonly in: unknown;
  readonly required: boolean;
  readonly schema: unknown;
}

/** A request body or a response: its JSON media type, else its first, with that media type's schema. */
export interface BazaarContent {
  readonly contentType: string;
  readonly schema: unknown;
}

/** AD-3: what the x402 Bazaar lists for one paid operation. */
export interface BazaarMetadata {
  // The operation's pay URL, with its {parameters}, such as https://pay.servicerouter.ai/service/weather/weather/{city}
  readonly resource: string;
  // Upper case, such as GET
  readonly method: string;
  readonly description: string;
  readonly input: {
    readonly parameters: readonly BazaarParameter[];
    readonly body: BazaarContent | null;
  };
  readonly output: BazaarContent | null;
  // The success response's example, when the seller's document has one
  readonly example: unknown;
}

// Keys of an operation that name upstream hosts or the seller's own credentials (AD-1)
const droppedOperationKeys = new Set(['servers', 'security', 'callbacks']);

export const withoutKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key)));

/**
 * The seller's operation object, without what must not reach agents (AD-1), with the path item's
 * parameters merged in: a parameter the path item declares applies unless the operation redeclares it.
 */
export const operationObject = (paths: unknown, operation: { readonly path: string; readonly method: HttpMethod }): Record<string, unknown> => {
  const pathItem = isRecord(paths) ? paths[operation.path] : undefined;
  const object = isRecord(pathItem) ? pathItem[operation.method] : undefined;
  if (!isRecord(object) || !isRecord(pathItem))
    return {};

  const own = withoutKeys(object, droppedOperationKeys);
  const shared = Array.isArray(pathItem['parameters']) ? pathItem['parameters'] : [];
  const ownParameters = Array.isArray(own['parameters']) ? own['parameters'] : [];
  const declared = new Set(ownParameters.filter(isRecord).map(parameter => `${String(parameter['in'])}:${String(parameter['name'])}`));
  const inherited = shared.filter(parameter => !isRecord(parameter) || !declared.has(`${String(parameter['in'])}:${String(parameter['name'])}`));

  return inherited.length > 0 ? { ...own, parameters: [...inherited, ...ownParameters] } : own;
};

/** The schema of a request body's or a response's media type: JSON's if it has one, else the first. */
const contentOf = (content: unknown): { readonly contentType: string; readonly schema: unknown; readonly example: unknown } | undefined => {
  if (!isRecord(content))
    return undefined;

  const [contentType, media] = Object.entries(content).find(([type]) => type.includes('json')) ?? Object.entries(content)[0] ?? [];
  if (contentType === undefined || !isRecord(media))
    return undefined;

  return { contentType, schema: media['schema'], example: media['example'] };
};

/**
 * AD-3: one operation's discovery metadata, from its operation object: a description, the input
 * (parameters and body), the success response's schema, and its example where the document has one.
 */
export const bazaarMetadata = ({ resource, method, description, object }: {
  readonly resource: string;
  readonly method: HttpMethod;
  readonly description: string;
  readonly object: Record<string, unknown>;
}): BazaarMetadata => {
  const responses = isRecord(object['responses']) ? object['responses'] : {};
  const success = ['200', '201', '2XX', '2xx', 'default'].map(key => responses[key]).find(isRecord);
  const output = success ? contentOf(success['content']) : undefined;
  const body = isRecord(object['requestBody']) ? contentOf(object['requestBody']['content']) : undefined;
  const parameters = Array.isArray(object['parameters']) ? object['parameters'].filter(isRecord) : [];

  return {
    resource,
    method: method.toUpperCase(),
    description,
    input: {
      parameters: parameters.map(parameter => ({
        name: parameter['name'], in: parameter['in'], required: parameter['required'] === true, schema: parameter['schema'] ?? null,
      })),
      body: body ? { contentType: body.contentType, schema: body.schema ?? null } : null,
    },
    output: output ? { contentType: output.contentType, schema: output.schema ?? null } : null,
    example: output?.example ?? null,
  };
};

// How many nodes inlined references may add to one operation, so a document whose schemas refer to
// each other many times over can't make a runtime grow without bound
const maxInlinedNodes = 5_000;

/** The value at a local JSON pointer, such as `#/components/schemas/Weather`, or undefined. */
const resolvePointer = (root: unknown, reference: string): unknown => {
  let node = root;
  for (const encoded of reference.slice(2).split('/')) {
    let key: string;
    try {
      key = decodeURIComponent(encoded).replaceAll('~1', '/').replaceAll('~0', '~');
    }
    catch {
      return undefined;
    }
    if (Array.isArray(node) && /^(?:0|[1-9][0-9]*)$/.test(key))
      node = node[Number(key)];
    else if (isRecord(node) && Object.hasOwn(node, key))
      node = node[key];
    else
      return undefined;
  }

  return node;
};

/**
 * A copy of `value` with each local `$ref`, such as `#/components/schemas/Weather`, replaced by what it
 * points to in `root`, the seller's OpenAPI document, so the metadata stands alone (AD-3). A reference
 * that is external, missing, recursive, or past the size budget becomes `{}`: anything.
 */
export const inlineLocalReferences = (value: unknown, root: unknown): unknown => {
  let budget = maxInlinedNodes;
  const visit = (node: unknown, trail: readonly string[]): unknown => {
    if (trail.length > 0)
      budget -= 1;
    if (Array.isArray(node))
      return node.map(item => visit(item, trail));
    if (!isRecord(node))
      return node;

    const reference = node['$ref'];
    if (typeof reference === 'string') {
      const target = reference.startsWith('#/') && !trail.includes(reference) && budget > 0 ? resolvePointer(root, reference) : undefined;

      return target === undefined ? {} : visit(target, [...trail, reference]);
    }

    return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, visit(item, trail)]));
  };

  return visit(value, []);
};
