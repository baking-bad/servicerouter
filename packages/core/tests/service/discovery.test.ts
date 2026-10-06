import { describe, expect, it } from 'vitest';

import type { ServiceId, ValidationIssue } from '@servicerouter/common';

import {
  compileServiceRuntime, generateServiceDocuments, inlineLocalReferences, isSameRevision, parseServiceConfig, validateServiceConfig,
  type BazaarMetadata, type ServiceConfigDocument, type ServiceRuntime,
} from '../../src/index.js';
import { examplePlatform, exampleContext, exampleServiceConfig, exampleServiceObject, patch } from '../fixtures.js';

const sellerOpenApiUrl = 'https://api.example.com/openapi.json';
const sellerOpenApi = {
  openapi: '3.1.0',
  info: { title: 'Weather', version: '1.0.0' },
  paths: {
    '/weather/{city}': {
      parameters: [{ name: 'city', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getWeather',
        summary: 'Current weather',
        description: 'Current weather for a city',
        parameters: [{ $ref: '#/components/parameters/Units' }],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Weather' }, example: { city: 'Oslo', celsius: 4 } } } },
        },
      },
    },
    '/forecast/{city}': { get: { operationId: 'getForecast', description: '14-day forecast' } },
    '/admin/reset': { post: { operationId: 'adminReset' } },
  },
  components: {
    parameters: { Units: { name: 'units', in: 'query', schema: { type: 'string', enum: ['metric', 'imperial'] } } },
    schemas: {
      Weather: { type: 'object', properties: { city: { type: 'string' }, celsius: { type: 'number' }, place: { $ref: '#/components/schemas/Place' } } },
      Place: { type: 'object', properties: { name: { type: 'string' }, near: { $ref: '#/components/schemas/Place' } } },
    },
  },
};

const configOf = (changes: unknown = {}): ServiceConfigDocument => {
  const parsed = parseServiceConfig(patch(exampleServiceObject(), changes) as Record<string, unknown>);
  if (!parsed.ok)
    throw new Error('The example config doesn\'t parse');

  return parsed.parsed.config;
};

const compile = (config: ServiceConfigDocument): ServiceRuntime => {
  const compiled = compileServiceRuntime({
    serviceId: 'my-app' as ServiceId, revision: 3, state: 'live', config, openapiDocuments: new Map([[sellerOpenApiUrl, sellerOpenApi]]), platform: examplePlatform,
  });
  if (!compiled.ok)
    throw new Error(`The config doesn't compile: ${JSON.stringify(compiled.errors)}`);

  return compiled.runtime;
};

const bazaarOf = (runtime: ServiceRuntime, path: string): BazaarMetadata | undefined =>
  runtime.operations.find(operation => operation.path === path)?.docs.bazaar;

describe('discovery metadata in the runtime (AD-3, PR-7)', () => {
  it('puts each paid operation\'s bazaar.json entry in the runtime, with the document\'s local references inlined', () => {
    const config = configOf();
    const runtime = compile(config);
    const stored = JSON.parse(generateServiceDocuments({
      config, openapiDocuments: new Map([[sellerOpenApiUrl, sellerOpenApi]]), runtime, platform: examplePlatform,
    })['bazaar.json'].content) as { operations: Record<string, unknown>[] };
    const weather = bazaarOf(runtime, '/weather/{city}')!;

    // The stored entry, as the seller wrote it
    expect(stored.operations[0]).toMatchObject({
      resource: weather.resource, method: 'GET', description: 'Current weather for a city', example: { city: 'Oslo', celsius: 4 },
      output: { contentType: 'application/json', schema: { $ref: '#/components/schemas/Weather' } },
    });
    // The runtime's: the same description, input, output, and example, with references inlined and recursion cut
    expect(weather).toEqual({
      resource: 'https://pay.staging.servicerouter.ai/service/my-app/weather/{city}',
      method: 'GET',
      description: 'Current weather for a city',
      input: {
        parameters: [
          { name: 'city', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'units', in: 'query', required: false, schema: { type: 'string', enum: ['metric', 'imperial'] } },
        ],
        body: null,
      },
      output: {
        contentType: 'application/json',
        schema: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            celsius: { type: 'number' },
            place: { type: 'object', properties: { name: { type: 'string' }, near: {} } },
          },
        },
      },
      example: { city: 'Oslo', celsius: 4 },
    });
    expect(bazaarOf(runtime, '/forecast/{city}')).toMatchObject({ description: '14-day forecast', output: null, example: null });
    expect(Object.isFrozen(weather.output!.schema)).toBe(true);
    // A copy: the seller's document isn't frozen or shared
    expect(Object.isFrozen(sellerOpenApi.components.schemas.Weather)).toBe(false);
  });

  it('gives free and disabled operations none', () => {
    const runtime = compile(configOf({ routes: { getForecast: { payment: { amount: '0' } } } }));

    expect(bazaarOf(runtime, '/forecast/{city}')).toBeUndefined();
    // adminReset is `enabled: false` in the example config
    expect(bazaarOf(runtime, '/admin/reset')).toBeUndefined();
    expect(bazaarOf(runtime, '/upload')).toMatchObject({ method: 'POST', description: 'Upload a file' });
  });
});

describe('service.discoverable (P-4)', () => {
  const errorsOf = (changes: unknown): readonly ValidationIssue[] => {
    const result = validateServiceConfig(patch(exampleServiceObject(), changes) as Record<string, unknown>, exampleContext);

    return result.ok ? [] : result.errors;
  };

  it('is listed by default, and discoverable: false keeps every operation out of the Bazaar', () => {
    expect(compile(configOf()).operations.filter(operation => operation.docs.bazaar !== undefined)).toHaveLength(3);
    expect(compile(configOf({ service: { discoverable: true } })).operations.filter(operation => operation.docs.bazaar !== undefined)).toHaveLength(3);
    expect(compile(configOf({ service: { discoverable: false } })).operations.map(operation => operation.docs.bazaar)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('is a boolean in the config schema', () => {
    expect(errorsOf({ service: { discoverable: false } })).toEqual([]);
    expect(errorsOf({ service: { discoverable: 'no' } })).toEqual([{ path: '/service/discoverable', message: 'must be true or false' }]);
  });

  it('makes a new revision when it changes, as any change does (SR-4)', () => {
    const documents = new Map([[sellerOpenApiUrl, sellerOpenApi]]);

    expect(isSameRevision({ config: configOf(), openapiDocuments: documents }, { config: configOf({ service: { discoverable: false } }), openapiDocuments: documents })).toBe(false);
    expect(isSameRevision({ config: configOf({ service: { discoverable: false } }), openapiDocuments: documents }, { config: configOf({ service: { discoverable: false } }), openapiDocuments: documents })).toBe(true);
  });

  it('leaves the generated per-service documents as they are (AD-6)', () => {
    const documentsOf = (config: ServiceConfigDocument) => generateServiceDocuments({
      config, openapiDocuments: new Map([[sellerOpenApiUrl, sellerOpenApi]]), runtime: compile(config), platform: examplePlatform,
    });
    const listed = documentsOf(configOf());
    const unlisted = documentsOf(configOf({ service: { discoverable: false } }));

    for (const kind of ['openapi.json', 'llms.txt', 'skill.md', 'bazaar.json'] as const) {
      expect(unlisted[kind].content).toBe(listed[kind].content);
      expect(unlisted[kind].content).not.toContain('discoverable');
    }
    expect(parseServiceConfig(exampleServiceConfig).ok).toBe(true);
  });
});

describe('inlineLocalReferences (AD-3)', () => {
  it('inlines local references, decoding JSON pointer escapes, and copies everything else', () => {
    const root = { components: { schemas: { 'a/b': { type: 'string' }, 'c~d': { type: 'number' } } }, list: [{ type: 'boolean' }] };
    const value = { one: { $ref: '#/components/schemas/a~1b' }, two: { $ref: '#/components/schemas/c~0d' }, three: { $ref: '#/list/0' }, plain: [1, 'x'] };

    const inlined = inlineLocalReferences(value, root);

    expect(inlined).toEqual({ one: { type: 'string' }, two: { type: 'number' }, three: { type: 'boolean' }, plain: [1, 'x'] });
    expect((inlined as { plain: unknown }).plain).not.toBe(value.plain);
  });

  it('makes an external, missing, or recursive reference anything ({})', () => {
    const root = { components: { schemas: { Node: { properties: { next: { $ref: '#/components/schemas/Node' } } } } } };

    expect(inlineLocalReferences({
      external: { $ref: 'https://example.com/schema.json' },
      missing: { $ref: '#/components/schemas/Nothing' },
      prototype: { $ref: '#/components/__proto__' },
      node: { $ref: '#/components/schemas/Node' },
    }, root)).toEqual({ external: {}, missing: {}, prototype: {}, node: { properties: { next: {} } } });
    expect(inlineLocalReferences({ $ref: '#/a' }, undefined)).toEqual({});
  });

  it('stops inlining past its budget, so references to references can\'t grow a runtime without bound', () => {
    // Each level refers to the next twice: 2^20 nodes if inlined in full
    const schemas = Object.fromEntries(Array.from({ length: 20 }, (_, level) => [`L${level}`, {
      properties: { left: { $ref: `#/components/schemas/L${level + 1}` }, right: { $ref: `#/components/schemas/L${level + 1}` } },
    }]));

    const inlined = inlineLocalReferences({ $ref: '#/components/schemas/L0' }, { components: { schemas } });

    expect(JSON.stringify(inlined).length).toBeLessThan(500_000);
  });
});
