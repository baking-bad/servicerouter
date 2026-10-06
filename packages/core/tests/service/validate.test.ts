import { describe, expect, it } from 'vitest';

import type { ValidationIssue } from '@servicerouter/common';

import { parseServiceConfig, validateServiceConfig, type ServiceConfigSource } from '../../src/index.js';
import { exampleContext, exampleServiceConfig, exampleServiceObject, patch } from '../fixtures.js';

const errorsOf = (source: ServiceConfigSource): readonly ValidationIssue[] => {
  const result = validateServiceConfig(source, exampleContext);
  if (result.ok)
    throw new Error('Expected validation to fail');

  return result.errors;
};

const errorsOfPatch = (changes: unknown) => errorsOf(patch(exampleServiceObject(), changes) as Record<string, unknown>);

describe('validateServiceConfig', () => {
  it('accepts the documented example without warnings', () => {
    const result = validateServiceConfig(exampleServiceConfig, exampleContext);

    expect(result).toMatchObject({ ok: true, warnings: [] });
    expect(result.ok && result.config.service.id).toBe('my-app');
  });

  it('accepts the same config as bytes, JSON text, and a JSON object', () => {
    for (const source of [Buffer.from(exampleServiceConfig), JSON.stringify(exampleServiceObject()), exampleServiceObject()])
      expect(validateServiceConfig(source, exampleContext)).toMatchObject({ ok: true });
  });

  it('returns a frozen copy and leaves the caller\'s object alone', () => {
    const source = exampleServiceObject();
    const result = validateServiceConfig(source, exampleContext);

    expect(result.ok && Object.isFrozen(result.config.upstreams[0])).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
  });

  it('reports a syntax error with its position, without echoing the source', () => {
    const errors = errorsOf('servicerouter:\n  version: "1"\nservice: [DO_NOT_ECHO');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ path: '', line: 3 });
    expect(JSON.stringify(errors)).not.toContain('DO_NOT_ECHO');
  });

  it('applies the strict loader to text', () => {
    expect(errorsOf(`${exampleServiceConfig}\nservice:\n  id: other\n`)[0]).toMatchObject({ message: 'duplicate key' });
    expect(errorsOf('servicerouter: &a { version: "1", self: *a }')[0]).toMatchObject({ message: 'the document must not contain cycles' });
  });

  it('applies the same safety checks to objects', () => {
    const value: unknown = JSON.parse('{"service": {"__proto__": {"id": "x"}}}');

    expect(errorsOf(value as Record<string, unknown>)).toEqual([{ path: '/service/__proto__', message: 'the key "__proto__" is not allowed' }]);
  });

  it('reports every schema problem at once, in source order, with lines and columns', () => {
    const broken = exampleServiceConfig
      .replace('version: "1"', 'version: 1')
      .replace('id: my-app', 'id: My_App')
      .replace('  category: weather\n', '  category: weather\n  color: blue\n')
      .replace('amount: "0.001"', 'amount: 0.001')
      .replace('    scheme: bearer', '    scheme: digest');

    expect(errorsOf(broken)).toEqual([
      { path: '/servicerouter/version', message: 'must be "1", the only config format version. Quote it: version: "1"', line: 2, column: 12 },
      { path: '/service/id', message: 'must be 1–64 lowercase letters, digits, or hyphens, starting and ending with a letter or digit', line: 5, column: 7 },
      { path: '/service/color', message: 'unknown field', line: 11, column: 3 },
      { path: '/payments/default/amount', message: 'must be a USD amount as a string with at most 6 decimal places, such as "0.001"', line: 28, column: 13 },
      { path: '/credentials/main-key/scheme', message: 'must be one of: "bearer", "basic"', line: 63, column: 13 },
    ]);
  });

  it('stops before the semantic checks when the schema fails', () => {
    const errors = errorsOfPatch({ service: { title: 'x'.repeat(61), category: 'sports' } });

    expect(errors).toEqual([{ path: '/service/title', message: 'must be one line of at most 60 characters' }]);
  });
});

describe('reserved fields (SR-9)', () => {
  it.each([
    ['rules', { routes: { getWeather: { rules: [] } } }, '/routes/getWeather/rules', 'rules are not supported yet'],
    ['chargeOn on a route', { routes: { getWeather: { chargeOn: ['2xx'] } } }, '/routes/getWeather/chargeOn', 'chargeOn is not supported yet'],
    ['chargeOn on a payment', { payments: { premium: { chargeOn: ['2xx'] } } }, '/payments/premium/chargeOn', 'chargeOn is not supported yet'],
    ['per-unit prices', { payments: { premium: { type: 'perUnit' } } }, '/payments/premium/type', 'per-unit prices are not supported yet'],
    ['per-unit inline prices', { routes: { getWeather: { payment: { unitPrice: '0.001' } } } }, '/routes/getWeather/payment/unitPrice', 'per-unit prices are not supported yet'],
    ['MCP upstreams', { upstreams: [{ baseUrl: 'https://api.example.com', type: 'mcp', openapi: 'https://api.example.com/openapi.json' }] }, '/upstreams/0/type', 'upstream type "mcp" is not supported yet'],
  ])('rejects %s as not supported yet, not as unknown', (_name, changes, path, message) => {
    expect(errorsOfPatch(changes)).toEqual([{ path, message }]);
  });

  it.each(['graphql', 'websocket', 'grpc'])('reserves the upstream type %s', type => {
    expect(errorsOfPatch({ upstreams: [{ baseUrl: 'https://api.example.com', type, openapi: 'https://api.example.com/openapi.json' }] }))
      .toEqual([{ path: '/upstreams/0/type', message: `upstream type "${type}" is not supported yet` }]);
  });

  it('still rejects unknown upstream types as invalid', () => {
    expect(errorsOfPatch({ upstreams: [{ baseUrl: 'https://api.example.com', type: 'soap', openapi: 'https://api.example.com/openapi.json' }] }))
      .toEqual([{ path: '/upstreams/0/type', message: 'must be "http"' }]);
  });
});

describe('schema (SR-2, pass 1)', () => {
  it.each([
    ['a missing section', { payments: undefined }, '', 'missing required field "payments"'],
    ['a missing default payment', { payments: { default: undefined } }, '/payments', 'missing required field "default"'],
    ['a default payment without an amount', { payments: { default: { amount: undefined } } }, '/payments/default', 'missing required field "amount"'],
    ['too many decimals', { payments: { premium: { amount: '0.0000001' } } }, '/payments/premium/amount', 'must be a USD amount as a string with at most 6 decimal places, such as "0.001"'],
    ['a negative amount', { payments: { premium: { amount: '-1' } } }, '/payments/premium/amount', 'must be a USD amount as a string with at most 6 decimal places, such as "0.001"'],
    ['an invalid payment name', { payments: { Premium: { amount: '1' } } }, '/payments/Premium', 'must be 1–32 lowercase letters, digits, or hyphens, starting and ending with a letter or digit'],
    ['a multi-line summary', { service: { summary: 'one\ntwo' } }, '/service/summary', 'must be one line of at most 120 characters'],
    ['an HTTP link', { service: { links: { docs: 'http://example.com/docs' } } }, '/service/links/docs', 'must be an HTTPS URL without credentials or a fragment'],
    ['an invalid email', { service: { contact: { email: 'support' } } }, '/service/contact/email', 'must be an email address'],
    ['duplicate tags', { service: { tags: ['geo', 'geo'] } }, '/service/tags', 'must not contain duplicates'],
    ['no upstreams', { upstreams: [] }, '/upstreams', 'must have at least 1 item'],
    ['an HTTP upstream', { upstreams: [{ baseUrl: 'http://api.example.com', openapi: 'https://api.example.com/openapi.json' }] }, '/upstreams/0/baseUrl', 'must be an HTTPS URL without credentials or a fragment'],
    ['credentials in a base URL', { upstreams: [{ baseUrl: 'https://user:pass@api.example.com', openapi: 'https://api.example.com/openapi.json' }] }, '/upstreams/0/baseUrl', 'must be an HTTPS URL without credentials or a fragment'],
    ['an upstream with neither openapi nor paths', { upstreams: [{ baseUrl: 'https://api.example.com' }] }, '/upstreams/0', 'set exactly one of "openapi" (a link to an OpenAPI document) or "paths" (inline OpenAPI paths)'],
    ['an upstream with both openapi and paths', { upstreams: [{ baseUrl: 'https://api.example.com', openapi: 'https://api.example.com/openapi.json', paths: { '/a': { get: {} } } }] }, '/upstreams/0', 'set exactly one of "openapi" (a link to an OpenAPI document) or "paths" (inline OpenAPI paths)'],
    ['an inline path without a slash', { upstreams: [{ baseUrl: 'https://api.example.com', paths: { upload: { post: {} } } }] }, '/upstreams/0/paths/upload', 'must be a path starting with "/", with {parameters} and without a query or fragment'],
    ['an unknown path item field', { upstreams: [{ baseUrl: 'https://api.example.com', paths: { '/a': { fetch: {} } } }] }, '/upstreams/0/paths/~1a/fetch', 'unknown field'],
    ['an empty auth list', { upstreams: [{ baseUrl: 'https://api.example.com', openapi: 'https://api.example.com/openapi.json', auth: [] }] }, '/upstreams/0/auth', 'must have at least 1 item'],
    ['a payment of the wrong type', { routes: { getWeather: { payment: 5 } } }, '/routes/getWeather/payment', 'must be a string or an object'],
    ['an invalid target path', { routes: { getForecast: { target: { path: '/forecast?city={city}' } } } }, '/routes/getForecast/target/path', 'must be a path starting with "/", with {parameters} and without a query or fragment'],
    ['a route key with spaces', { routes: { 'get weather': {} } }, '/routes/get weather', 'must be an operationId, or <upstream>/<operationId>'],
    ['a credential without a type', { credentials: { 'main-key': { type: undefined } } }, '/credentials/main-key', 'missing required field "type"'],
    ['an unknown credential type', { credentials: { 'main-key': { type: 'oauth2' } } }, '/credentials/main-key/type', 'must be one of: "http", "apiKey"'],
    ['an inline secret value', { credentials: { 'main-key': { secret: 'Bearer sk_live_123' } } }, '/credentials/main-key/secret', 'must be a secret name: 1–64 lowercase letters, digits, hyphens, or underscores. Send the value in the request\'s secrets, never in the config'],
    ['an invalid header name', { credentials: { 'files-key': { name: 'X Api Key' } } }, '/credentials/files-key/name', 'must be a valid HTTP header name'],
    ['an invalid query parameter name', { credentials: { 'files-key': { in: 'query', name: 'api key' } } }, '/credentials/files-key/name', 'must be a query parameter name: letters, digits, ".", "_", "~", or "-"'],
    ['an invalid cookie name', { credentials: { 'files-key': { in: 'cookie', name: 'a;b' } } }, '/credentials/files-key/name', 'must be a valid cookie name'],
  ])('rejects %s', (_name, changes, path, message) => {
    expect(errorsOfPatch(changes)).toContainEqual({ path, message });
  });

  it('accepts optional sections left out', () => {
    const minimal = patch(exampleServiceObject(), {
      routes: undefined,
      credentials: undefined,
      service: { summary: undefined, tags: undefined, links: undefined, contact: undefined },
      payments: { premium: undefined },
      upstreams: [{ baseUrl: 'https://api.example.com/v1/', openapi: 'https://api.example.com/openapi.json' }],
    }) as Record<string, unknown>;

    expect(validateServiceConfig(minimal, exampleContext)).toMatchObject({ ok: true, warnings: [] });
  });

  it('accepts free routes', () => {
    expect(validateServiceConfig(patch(exampleServiceObject(), { routes: { getForecast: { payment: { amount: '0' } } } }) as Record<string, unknown>, exampleContext))
      .toMatchObject({ ok: true });
  });
});

describe('parseServiceConfig', () => {
  it('validates the shape without the platform or OpenAPI documents', () => {
    const result = parseServiceConfig(exampleServiceConfig);

    expect(result.ok).toBe(true);
    expect(result.ok && result.parsed.document?.locate(['service', 'id'])).toEqual({ line: 5, column: 7 });
  });
});
