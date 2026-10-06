import { isRecord, type LogSink } from '@servicerouter/common';
import type { BazaarMetadata } from '@servicerouter/core';
import type { HTTPRequestContext, x402ResourceServer } from '@x402/core/server';
import {
  BAZAAR, bazaarResourceServerExtension, declareDiscoveryExtension, isValidRouteTemplate, validateDiscoveryExtension,
  type DeclareDiscoveryExtensionInput, type DiscoveryExtension,
} from '@x402/extensions/bazaar';

// PR-7: the x402 Bazaar extension on the challenge, with the SDK's API (`@x402/extensions`). The
// declaration comes from the operation's AD-3 metadata in the runtime, made once per runtime; each
// challenge only adds the request's method and path parameters, as the SDK's HTTP server does.

/** The extension's key in `PAYMENT-REQUIRED`'s `extensions`: `bazaar`. */
export const bazaarExtensionKey = BAZAAR.key;

export { bazaarResourceServerExtension };

/** One operation's declaration, ready for each request. */
interface Declaration {
  readonly extension: DiscoveryExtension;
  readonly method: string;
  // The pay URL's path with `:parameters`, so the Bazaar lists the operation once, not each URL
  readonly routePattern: string | undefined;
  // From the metadata: the resource's description and media type
  readonly description: string;
  readonly mimeType: string | undefined;
}

const queryMethods = new Set(['GET', 'HEAD', 'DELETE']);
const bodyMethods = new Set(['POST', 'PUT', 'PATCH']);
const parameterName = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Keys that make the Bazaar refuse a schema as external (`$id`, `$ref`) or that only apply at a schema's root
const schemaIdKeys = new Set(['$id', '$ref', '$schema', '$anchor', '$dynamicAnchor', '$dynamicRef']);

/** A copy of a schema without the keys the extension can't carry. Not a schema: anything. */
const portable = (schema: unknown): Record<string, unknown> => {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node))
      return node.map(strip);
    if (!isRecord(node))
      return node;

    return Object.fromEntries(Object.entries(node).filter(([key, value]) => !(schemaIdKeys.has(key) && typeof value === 'string')).map(([key, value]) => [key, strip(value)]));
  };
  const copy = strip(schema);

  return isRecord(copy) ? copy : {};
};

/**
 * The extension as the Bazaar validates it, without `format`: the SDK's validator knows no formats and
 * ignores them, warning on the console for each.
 */
const withoutFormats = (node: unknown): unknown => {
  if (Array.isArray(node))
    return node.map(withoutFormats);
  if (!isRecord(node))
    return node;

  return Object.fromEntries(Object.entries(node).filter(([key, value]) => !(key === 'format' && typeof value === 'string')).map(([key, value]) => [key, withoutFormats(value)]));
};

/** A value a schema shows: its example, default, first enum value, or first of its examples. */
const exampleOf = (schema: unknown): unknown => {
  if (!isRecord(schema))
    return undefined;
  if (schema['example'] !== undefined)
    return schema['example'];
  if (schema['default'] !== undefined)
    return schema['default'];
  for (const key of ['enum', 'examples']) {
    const values = schema[key];
    if (Array.isArray(values) && values.length > 0)
      return values[0];
  }

  return undefined;
};

const bodyTypeOf = (contentType: string | undefined): 'json' | 'form-data' | 'text' => {
  const type = contentType?.toLowerCase() ?? 'application/json';
  if (type.includes('json'))
    return 'json';
  if (type.startsWith('multipart/form-data') || type.startsWith('application/x-www-form-urlencoded'))
    return 'form-data';

  return 'text';
};

/**
 * The route pattern of a pay URL template, such as `/service/weather/weather/:city` for
 * `…/service/weather/weather/{city}`. Undefined when the SDK can't read it: a parameter name it
 * doesn't take, a literal `:`, or a character a route template can't hold.
 */
const routePatternOf = (resource: string): string | undefined => {
  const path = resource.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  const parts = path.split(/\{([^{}]+)\}/);
  if (parts.length === 1)
    return undefined;
  if (parts.some((part, index) => index % 2 === 1 ? !parameterName.test(part) : part.includes(':')))
    return undefined;
  const pattern = parts.map((part, index) => index % 2 === 1 ? `:${part}` : part).join('');

  return isValidRouteTemplate(pattern) ? pattern : undefined;
};

/** The SDK's HTTP request context for one call, which the Bazaar extension reads the method and path parameters from. */
const requestContext = (method: string, url: string, routePattern: string | undefined): HTTPRequestContext => {
  const path = new URL(url).pathname;

  return {
    method,
    path,
    adapter: {
      getHeader: () => undefined,
      getMethod: () => method,
      getPath: () => path,
      getUrl: () => url,
      getAcceptHeader: () => 'application/json',
      getUserAgent: () => '',
    },
    ...routePattern === undefined ? {} : { routePattern },
  };
};

/**
 * The declarations to try, fullest first: everything; without the output's schema; without any schema;
 * the method alone. A seller's schema may not compile, or its example may not match it, and the Bazaar
 * drops an extension that doesn't validate, so a smaller one that does is better than none.
 */
const configsOf = (metadata: BazaarMetadata): readonly DeclareDiscoveryExtensionInput[] => {
  const parameters = metadata.input.parameters.filter((parameter): parameter is typeof parameter & { readonly name: string } => typeof parameter.name === 'string');
  // A path parameter's value is the URL's text, so its schema says string
  const pathParameters = parameters.filter(parameter => parameter.in === 'path');
  const pathParamsSchema = pathParameters.length === 0 ? undefined : {
    properties: Object.fromEntries(pathParameters.map(parameter => {
      const description = isRecord(parameter.schema) && typeof parameter.schema['description'] === 'string' ? parameter.schema['description'] : undefined;

      return [parameter.name, { type: 'string', ...description === undefined ? {} : { description } }];
    })),
  };
  const example = metadata.example ?? undefined;
  const outputSchema = isRecord(metadata.output?.schema) ? portable(metadata.output.schema) : undefined;
  const output = example === undefined ? undefined : { example, ...outputSchema === undefined ? {} : { schema: outputSchema } };
  const exampleOnly = example === undefined ? undefined : { example };
  const withPath = pathParamsSchema === undefined ? {} : { pathParamsSchema };

  if (bodyMethods.has(metadata.method)) {
    const bodyType = bodyTypeOf(metadata.input.body?.contentType);
    const schema = isRecord(metadata.input.body?.schema) ? portable(metadata.input.body.schema) : undefined;
    const sample = exampleOf(schema);
    let body: { readonly input?: Record<string, unknown>; readonly inputSchema?: Record<string, unknown> } = {};
    if (schema && isRecord(sample))
      body = { input: sample, inputSchema: schema };
    else if (schema) {
      // Without an example body, the schema can't require fields the declared input lacks
      const { required: _required, ...optional } = schema;
      body = { inputSchema: optional };
    }

    return [
      { bodyType, ...body, ...withPath, ...output === undefined ? {} : { output } },
      { bodyType, ...body, ...withPath, ...exampleOnly === undefined ? {} : { output: exampleOnly } },
      { bodyType, ...withPath, ...exampleOnly === undefined ? {} : { output: exampleOnly } },
      { bodyType },
    ];
  }

  const query = parameters.filter(parameter => parameter.in === 'query');
  const samples = Object.fromEntries(query.flatMap(parameter => {
    const sample = exampleOf(parameter.schema);

    return sample === undefined ? [] : [[parameter.name, sample]];
  }));
  // A required parameter is listed as required only with a value to show for it
  const required = query.filter(parameter => parameter.required && Object.hasOwn(samples, parameter.name)).map(parameter => parameter.name);
  const inputSchema = {
    properties: Object.fromEntries(query.map(parameter => [parameter.name, portable(parameter.schema)])),
    ...required.length === 0 ? {} : { required },
  };
  const loose = { properties: Object.fromEntries(query.map(parameter => [parameter.name, {}])) };

  return [
    { input: samples, inputSchema, ...withPath, ...output === undefined ? {} : { output } },
    { input: samples, inputSchema, ...withPath, ...exampleOnly === undefined ? {} : { output: exampleOnly } },
    { input: samples, inputSchema: loose, ...withPath, ...exampleOnly === undefined ? {} : { output: exampleOnly } },
    {},
  ];
};

export interface BazaarDeclarations {
  /**
   * The Bazaar extension for a quote's challenge (PR-7), enriched for the call's method and path, or
   * undefined when the quote carries no discovery metadata: a routed call, a free operation, or a
   * service with `discoverable: false` (P-4).
   */
  extensionsFor(discovery: BazaarMetadata | undefined, resource: string): Record<string, unknown> | undefined;
  /** The resource's description and media type the Bazaar lists, from the metadata. */
  resourceOf(discovery: BazaarMetadata | undefined): { readonly description: string; readonly mimeType: string | undefined } | undefined;
}

/**
 * The Bazaar declarations of a resource server that registered `bazaarResourceServerExtension`. Each
 * operation's declaration is made once, from the runtime's frozen metadata, and checked with the
 * SDK's validator, falling back to a smaller one the Bazaar accepts.
 */
export const createBazaarDeclarations = (server: x402ResourceServer, logger: LogSink): BazaarDeclarations => {
  const made = new WeakMap<BazaarMetadata, Declaration | null>();

  const declarationOf = (metadata: BazaarMetadata): Declaration | undefined => {
    const known = made.get(metadata);
    if (known !== undefined)
      return known ?? undefined;

    let declaration: Declaration | undefined;
    try {
      if (queryMethods.has(metadata.method) || bodyMethods.has(metadata.method)) {
        const routePattern = routePatternOf(metadata.resource);
        // A request the pattern matches, to check the declaration as a challenge carries it
        const probe = new URL((routePattern ?? new URL(metadata.resource.replaceAll(/[{}]/g, '')).pathname).replaceAll(/:[A-Za-z_][A-Za-z0-9_]*/g, 'x'), metadata.resource).href;
        for (const [index, config] of configsOf(metadata).entries()) {
          const extension = declareDiscoveryExtension(config)[bazaarExtensionKey]!;
          const enriched = server.enrichExtensions({ [bazaarExtensionKey]: extension }, requestContext(metadata.method, probe, routePattern));
          if (!validateDiscoveryExtension(withoutFormats(enriched[bazaarExtensionKey]) as DiscoveryExtension).valid)
            continue;
          if (index > 0) {
            logger.info({ resource: metadata.resource, method: metadata.method, dropped: ['the output schema', 'every schema', 'the input and the output'][index - 1] },
              'An operation\'s x402 Bazaar metadata doesn\'t validate in full: the challenge carries less of it');
          }
          declaration = { extension, method: metadata.method, routePattern, description: metadata.description, mimeType: metadata.output?.contentType };
          break;
        }
      }
    }
    catch (error) {
      logger.warn({ resource: metadata.resource, method: metadata.method, error }, 'An operation\'s x402 Bazaar metadata couldn\'t be declared: the challenge carries none');
    }
    made.set(metadata, declaration ?? null);

    return declaration;
  };

  return {
    extensionsFor: (discovery, resource) => {
      const declaration = discovery === undefined ? undefined : declarationOf(discovery);
      if (!declaration)
        return undefined;

      return server.enrichExtensions({ [bazaarExtensionKey]: declaration.extension }, requestContext(declaration.method, resource, declaration.routePattern));
    },
    resourceOf: discovery => {
      const declaration = discovery === undefined ? undefined : declarationOf(discovery);

      return declaration ? { description: declaration.description, mimeType: declaration.mimeType } : undefined;
    },
  };
};
