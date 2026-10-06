import { describe, expect, it } from 'vitest';

import type { ValidationIssue } from '@servicerouter/common';

import {
  compileServiceRuntime, parseServiceConfig, targetPath, validateAndCompileServiceConfig, type CompileServiceRuntimeInput,
  type RuntimeOperation, type ServiceRuntime,
} from '../../src/index.js';
import { exampleContext, examplePlatform, exampleServiceConfig, exampleServiceObject, patch, weatherOpenApi, weatherOpenApiUrl } from '../fixtures.js';

interface EditableConfig {
  readonly upstreams: Record<string, unknown>[];
  readonly routes: Record<string, unknown>;
  readonly [field: string]: unknown;
}

// The example config, changed in place. `patch` replaces arrays, so this edits one upstream.
const edit = (mutate: (config: EditableConfig) => void): Record<string, unknown> => {
  const config = exampleServiceObject() as EditableConfig;
  mutate(config);

  return config;
};

// `changes` is a whole config from `edit`, or changes to patch onto the example
const input = (changes: Record<string, unknown> = {}, documents: ReadonlyMap<string, unknown> = exampleContext.openapiDocuments!): CompileServiceRuntimeInput => {
  const config = 'servicerouter' in changes ? changes : patch(exampleServiceObject(), changes) as Record<string, unknown>;
  const parsed = parseServiceConfig(config);
  if (!parsed.ok)
    throw new Error(`The test config is invalid: ${JSON.stringify(parsed.errors)}`);

  return { serviceId: 'my-app', revision: 3, state: 'live', config: parsed.parsed.config, openapiDocuments: documents, platform: examplePlatform };
};

const compile = (changes?: Record<string, unknown>, documents?: ReadonlyMap<string, unknown>): ServiceRuntime => {
  const result = compileServiceRuntime(input(changes, documents));
  if (!result.ok)
    throw new Error(`Expected the config to compile: ${JSON.stringify(result.errors)}`);

  return result.runtime;
};

const errorsOf = (value: CompileServiceRuntimeInput): readonly ValidationIssue[] => {
  const result = compileServiceRuntime(value);
  if (result.ok)
    throw new Error('Expected compiling to fail');

  return result.errors;
};

const operation = (runtime: ServiceRuntime, method: string, path: string): RuntimeOperation => {
  const found = runtime.operations.find(item => item.method === method && item.path === path);
  if (!found)
    throw new Error(`No operation ${method} ${path}`);

  return found;
};

// Every object and function reachable from the value, including non-enumerable properties
const unfrozenPaths = (value: unknown, path = '', seen = new Set<unknown>()): readonly string[] => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function')
    return [];
  if (seen.has(value))
    return [];
  seen.add(value);

  return [
    ...Object.isFrozen(value) ? [] : [path || '/'],
    ...Reflect.ownKeys(value).flatMap(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      return descriptor && 'value' in descriptor ? unfrozenPaths(descriptor.value, `${path}/${String(key)}`, seen) : [];
    }),
  ];
};

const propertyNames = (value: unknown, names = new Set<string>()): Set<string> => {
  if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      names.add(key);
      propertyNames(nested, names);
    }
  }

  return names;
};

describe('compileServiceRuntime (SR-5)', () => {
  it('compiles an openapi link and inline paths into every operation, deeply frozen (SR-5)', () => {
    const runtime = compile();

    expect(runtime).toMatchObject({ serviceId: 'my-app', revision: 3, state: 'live' });
    expect(runtime.operations.map(item => [item.method, item.path, item.routeKey, item.upstream.name, item.target, item.price, item.enabled])).toEqual([
      ['get', '/weather/{city}', 'getWeather', 'main', '/weather/{city}', 10_000n, true],
      ['get', '/forecast/{city}', 'getForecast', 'main', '/internal/forecast/{city}', 1_000n, true],
      ['post', '/admin/reset', 'adminReset', 'main', '/admin/reset', 1_000n, false],
      ['post', '/upload', 'uploadFile', 'files', '/upload', 10_000n, true],
    ]);
    expect(operation(runtime, 'post', '/upload').docs).toEqual({
      operationId: 'uploadFile',
      summary: 'Upload a file',
      description: undefined,
      // AD-3, PR-7: a paid operation carries its discovery metadata
      bazaar: {
        resource: 'https://pay.staging.servicerouter.ai/service/my-app/upload', method: 'POST', description: 'Upload a file',
        input: { parameters: [], body: null }, output: null, example: null,
      },
    });
    expect(operation(runtime, 'get', '/weather/{city}').upstream).toEqual({
      name: 'main', baseUrl: 'https://api.example.com', origin: 'https://api.example.com', pathPrefix: '',
    });
    expect(unfrozenPaths(runtime)).toEqual([]);
    expect(Object.isFrozen(runtime.match)).toBe(true);
    expect(() => (runtime.operations as RuntimeOperation[]).pop()).toThrow(TypeError);
  });

  it('gives deep-equal runtimes for the same input (SR-5)', () => {
    const value = input();
    const first = compileServiceRuntime(value);
    const second = compileServiceRuntime(value);

    expect(first.ok && second.ok).toBe(true);
    expect(first).toEqual(second);
    expect(first.ok && second.ok && first.runtime !== second.runtime).toBe(true);
    expect(first.ok && first.runtime.match('GET', ['weather', 'oslo'])).toEqual(second.ok && second.runtime.match('GET', ['weather', 'oslo']));
  });

  it('keeps match out of the data, so a runtime compares and prints by its fields', () => {
    const runtime = compile();

    expect(Object.keys(runtime)).toEqual(['serviceId', 'revision', 'state', 'operations']);
    expect(typeof runtime.match).toBe('function');
  });

  describe('prices in micro-USD (SR-5, CK-4)', () => {
    it.each([
      ['the default only', 'get', '/forecast/{city}', 1_000n],
      ['a named payment', 'get', '/weather/{city}', 10_000n],
      ['an inline payment', 'post', '/upload', 10_000n],
    ])('takes %s', (_name, method, path, price) => {
      expect(operation(compile(), method, path).price).toBe(price);
    });

    it('lets a named payment without an amount keep the default, and allows free routes', () => {
      const runtime = compile({
        payments: { default: { amount: '0.25' }, premium: { amount: undefined } },
        routes: { getForecast: { payment: { amount: '0' } } },
      });

      expect(operation(runtime, 'get', '/weather/{city}').price).toBe(250_000n);
      expect(operation(runtime, 'get', '/forecast/{city}').price).toBe(0n);
    });

    it('converts amounts exactly, with all 6 decimal places', () => {
      expect(operation(compile({ payments: { default: { amount: '1.234567' } } }), 'get', '/forecast/{city}').price).toBe(1_234_567n);
    });
  });

  it('resolves <upstream>/<operationId> route keys when two upstreams share an operationId (SR-6)', () => {
    const value = exampleServiceObject();
    const upstreams = value['upstreams'] as unknown[];
    const changes = {
      upstreams: [...upstreams, { baseUrl: 'https://v2.example.com', name: 'v2', paths: { '/v2/weather/{city}': { get: { operationId: 'getWeather' } } } }],
      routes: { 'getWeather': undefined, 'main/getWeather': { payment: 'premium' }, 'v2/getWeather': { payment: { amount: '0.5' } } },
    };
    const runtime = compile(changes);

    expect(operation(runtime, 'get', '/weather/{city}')).toMatchObject({ routeKey: 'main/getWeather', price: 10_000n, upstream: { name: 'main' } });
    expect(operation(runtime, 'get', '/v2/weather/{city}')).toMatchObject({ routeKey: 'v2/getWeather', price: 500_000n, upstream: { name: 'v2' } });
    expect(validateAndCompileServiceConfig(patch(exampleServiceObject(), changes) as Record<string, unknown>, { ...exampleContext, revision: 1, state: 'pending' }))
      .toMatchObject({ ok: true });
  });

  it('gives an operation without an operationId no route key and the default price', () => {
    const runtime = compile(edit(config => {
      config.upstreams[1]!['paths'] = { '/upload': { post: { summary: 'Upload a file' } } };
      delete config.routes['files/uploadFile'];
    }));

    expect(operation(runtime, 'post', '/upload')).toMatchObject({ routeKey: undefined, price: 1_000n, enabled: true });
  });

  describe('targetPath', () => {
    it('fills in target.path and keeps percent-encoded params encoded', () => {
      const runtime = compile();
      const match = runtime.match('GET', ['forecast', 'S%C3%A3o%20Paulo'])!;

      expect(match.params).toEqual({ city: 'S%C3%A3o%20Paulo' });
      expect(targetPath(match.operation, match.params)).toBe('/internal/forecast/S%C3%A3o%20Paulo');
      expect(targetPath(match.operation, { city: 'a%2Fb' })).toBe('/internal/forecast/a%2Fb');
    });

    it('puts the base URL\'s path prefix first, without a doubled slash', () => {
      const runtime = compile(edit(config => {
        config.upstreams[0]!['baseUrl'] = 'https://api.example.com/v1/';
      }));
      const match = runtime.match('GET', ['weather', 'oslo'])!;

      expect(match.operation.upstream).toMatchObject({ baseUrl: 'https://api.example.com/v1', origin: 'https://api.example.com', pathPrefix: '/v1' });
      expect(targetPath(match.operation, match.params)).toBe('/v1/weather/oslo');
      expect(targetPath(runtime.match('GET', ['forecast', 'oslo'])!.operation, { city: 'oslo' })).toBe('/v1/internal/forecast/oslo');
    });

    it('normalizes literal text in the target, and refuses a missing param', () => {
      const runtime = compile({ routes: { getForecast: { target: { path: '/prévisions/{city}' } } } });
      const forecast = operation(runtime, 'get', '/forecast/{city}');

      expect(forecast.target).toBe('/pr%C3%A9visions/{city}');
      expect(targetPath(forecast, { city: 'oslo' })).toBe('/pr%C3%A9visions/oslo');
      expect(() => targetPath(forecast, {})).toThrow(TypeError);
    });
  });

  it('carries credential references with the secret name and how to apply it, never a value (SR-5)', () => {
    const runtime = compile({ credentials: { 'files-app': { in: 'query', name: 'app_id' } } });

    expect(operation(compile(), 'get', '/weather/{city}').credentials).toEqual([
      { credential: 'main-key', apply: { type: 'bearer' }, secretName: 'weather-key' },
    ]);
    expect(operation(runtime, 'post', '/upload').credentials).toEqual([
      { credential: 'files-key', apply: { type: 'apiKey', in: 'header', name: 'X-Api-Key' }, secretName: 'files-key' },
      { credential: 'files-app', apply: { type: 'apiKey', in: 'query', name: 'app_id' }, secretName: 'files-app-id' },
    ]);
    expect([...propertyNames(runtime)].filter(name => /secret|value|password|token/i.test(name))).toEqual(['secretName']);
  });

  it('reads basic credentials too', () => {
    const runtime = compile({ credentials: { 'main-key': { scheme: 'basic' } } });

    expect(operation(runtime, 'get', '/weather/{city}').credentials).toEqual([
      { credential: 'main-key', apply: { type: 'basic' }, secretName: 'weather-key' },
    ]);
  });

  describe('problems', () => {
    it.each([
      ['two parameters in one segment', '/files/{a}-{b}', 'has 2 parameters in one segment. A segment can hold only one'],
      ['a parameter used twice', '/files/{id}/copies/{id}', 'uses the parameter {id} twice'],
    ])('reports %s in an inline path at that path', (_name, path, message) => {
      const errors = errorsOf(input(edit(config => {
        config.upstreams[1]!['paths'] = { [path]: { get: { operationId: 'other' } } };
        delete config.routes['files/uploadFile'];
      })));

      expect(errors).toEqual([{ path: `/upstreams/1/paths/${path.replaceAll('/', '~1')}`, message: `GET ${path} can't be compiled: the path ${message}` }]);
    });

    it('reports a broken path in a fetched document at its link', () => {
      const document = { ...weatherOpenApi, paths: { ...weatherOpenApi.paths, '/stations/{id': { get: { operationId: 'getStation' } } } };

      expect(errorsOf(input({}, new Map([[weatherOpenApiUrl, document]])))).toEqual([
        { path: '/upstreams/0/openapi', message: 'GET /stations/{id can\'t be compiled: the path has a "{" or "}" that is not part of a {parameter}' },
      ]);
    });

    it('reports two operations that match the same requests', () => {
      const document = { ...weatherOpenApi, paths: { ...weatherOpenApi.paths, '/weather/{town}': { get: { operationId: 'getTown' } } } };

      expect(errorsOf(input({}, new Map([[weatherOpenApiUrl, document]])))).toEqual([
        { path: '/upstreams/0/openapi', message: 'GET /weather/{town} matches the same requests as GET /weather/{city}' },
      ]);
    });

    it('reports a missing document instead of throwing', () => {
      expect(errorsOf(input({}, new Map()))).toEqual([
        { path: '/upstreams/0/openapi', message: 'can\'t be compiled: it was not loaded' },
        { path: '/routes/getWeather', message: 'matches no operation' },
        { path: '/routes/getForecast', message: 'matches no operation' },
        { path: '/routes/adminReset', message: 'matches no operation' },
      ]);
    });

    it('returns errors for input that is not a valid config, a service ID, a revision, or a state', () => {
      const value = input();

      expect(errorsOf({ ...value, config: { upstreams: 'none' } as never }).length).toBeGreaterThan(0);
      expect(errorsOf({ ...value, serviceId: 'Not An ID', revision: 0, state: 'gone' as never })).toEqual([
        { path: '', message: 'the service ID is not valid' },
        { path: '', message: 'the revision must be a positive integer' },
        { path: '', message: 'the state must be one of: pending, live, suspended' },
      ]);
    });
  });
});

describe('validateAndCompileServiceConfig (SR-2)', () => {
  const context = { ...exampleContext, revision: 1, state: 'pending' as const };

  it('runs all three passes and returns the runtime', () => {
    const result = validateAndCompileServiceConfig(exampleServiceConfig, context);

    expect(result).toMatchObject({ ok: true, warnings: [], runtime: { serviceId: 'my-app', revision: 1, state: 'pending' } });
  });

  it('reports a compile problem in text with its line and column (SR-2, pass 3)', () => {
    const source = exampleServiceConfig.replace('      /upload:\n', '      /upload/{a}-{b}:\n');
    const result = validateAndCompileServiceConfig(source, context);
    const line = source.split('\n').findIndex(text => text.includes('/upload/{a}-{b}:')) + 1;

    expect(result).toEqual({
      ok: false,
      warnings: [],
      errors: [{
        path: '/upstreams/1/paths/~1upload~1{a}-{b}',
        message: 'POST /upload/{a}-{b} can\'t be compiled: the path has 2 parameters in one segment. A segment can hold only one',
        line,
        column: 7,
      }],
    });
  });

  it('stops at the first failing pass', () => {
    const result = validateAndCompileServiceConfig(exampleServiceConfig.replace('category: weather', 'category: unknown'), context);

    expect(result).toMatchObject({ ok: false, errors: [{ path: '/service/category' }] });
  });
});
