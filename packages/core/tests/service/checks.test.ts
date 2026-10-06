import { describe, expect, it } from 'vitest';

import type { ValidationIssue } from '@servicerouter/common';

import { getOpenApiLinks, validateServiceConfig, type ServiceConfigContext, type ServiceConfigDocument } from '../../src/index.js';
import {
  exampleContext, exampleServiceConfig, exampleServiceObject, mainnetEnterpriseAddress, patch, weatherOpenApi, weatherOpenApiUrl,
} from '../fixtures.js';

const validate = (changes: unknown, context: Partial<ServiceConfigContext> = {}) =>
  validateServiceConfig(patch(exampleServiceObject(), changes) as Record<string, unknown>, { ...exampleContext, ...context });

const errors = (changes: unknown, context?: Partial<ServiceConfigContext>): readonly ValidationIssue[] => {
  const result = validate(changes, context);
  if (result.ok)
    throw new Error('Expected validation to fail');

  return result.errors;
};

const mainUpstream = { baseUrl: 'https://api.example.com', name: 'main', openapi: weatherOpenApiUrl, auth: 'main-key' };
const filesUpstream = (paths: unknown) => ({ baseUrl: 'https://files.example.com', name: 'files', paths, auth: ['files-key', 'files-app'] });

describe('checkServiceConfig (SR-2, pass 2)', () => {
  it('reports semantic errors with lines and columns when the source was text', () => {
    const result = validateServiceConfig(exampleServiceConfig.replace('category: weather', 'category: sports'), exampleContext);

    expect(result).toMatchObject({
      ok: false,
      errors: [{
        path: '/service/category',
        message: 'is not a platform category. Categories: "weather", "finance", "finance/market-data", "ai/image-generation"',
        line: 10,
        column: 13,
      }],
    });
  });

  it('accepts hierarchical categories from the platform list', () => {
    expect(validate({ service: { category: 'finance/market-data' } }).ok).toBe(true);
  });

  describe('payouts', () => {
    it('requires a payout asset', () => {
      expect(errors({ payouts: { default: { asset: 'base-usdc' } } })).toEqual([
        { path: '/payouts/default/asset', message: 'is not a payout asset. Payout assets: "cardano-usdm"' },
      ]);
    });

    it('requires an address on the payout asset\'s network', () => {
      expect(errors({ payouts: { default: { address: mainnetEnterpriseAddress } } })).toEqual([
        { path: '/payouts/default/address', message: 'is not a valid address on Cardano Preprod' },
      ]);
      expect(errors({ payouts: { default: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' } } })).toHaveLength(1);
    });
  });

  it('rejects amounts that overflow', () => {
    expect(errors({ payments: { premium: { amount: '99999999999999' } } })).toEqual([
      { path: '/payments/premium/amount', message: 'The USD amount is too large' },
    ]);
    expect(errors({ routes: { getWeather: { payment: { amount: '99999999999999' } } } })).toContainEqual(
      { path: '/routes/getWeather/payment/amount', message: 'The USD amount is too large' },
    );
  });

  describe('upstreams', () => {
    it.each([
      ['an IPv4 address', 'https://203.0.113.10', 'must use a hostname, not an IP address'],
      ['an IPv6 address', 'https://[2001:db8::1]', 'must use a hostname, not an IP address'],
      ['localhost', 'https://localhost:8443', 'must use a public hostname'],
      ['localhost with a trailing dot', 'https://localhost./api', 'must use a public hostname'],
      ['a single-label host', 'https://intranet', 'must use a public hostname'],
      ['a .internal host', 'https://api.corp.internal', 'must use a public hostname'],
      ['a .local host', 'https://printer.local', 'must use a public hostname'],
      ['a platform host', 'https://pay.staging.servicerouter.ai', 'must not point at the platform'],
      ['a platform subdomain', 'https://evil.api.staging.servicerouter.ai', 'must not point at the platform'],
      ['a query', 'https://api.example.com/v1?key=1', 'must not have a query'],
    ])('rejects a base URL with %s', (_name, baseUrl, message) => {
      expect(errors({ upstreams: [{ ...mainUpstream, baseUrl }] })).toContainEqual({ path: '/upstreams/0/baseUrl', message });
    });

    it('accepts a base URL with a port and a path prefix', () => {
      expect(validate({ upstreams: [{ ...mainUpstream, baseUrl: 'https://API.Example.com:8443/v1/' }], routes: { 'files/uploadFile': undefined } }).ok).toBe(true);
    });

    it('rejects duplicate upstream names', () => {
      expect(errors({ upstreams: [mainUpstream, { ...filesUpstream({ '/upload': { post: { operationId: 'uploadFile' } } }), name: 'main' }] }))
        .toContainEqual({ path: '/upstreams/1/name', message: 'duplicate upstream name "main"' });
    });

    it('requires every linked OpenAPI document', () => {
      expect(errors({}, { openapiDocuments: new Map() })).toContainEqual(
        { path: '/upstreams/0/openapi', message: 'the linked OpenAPI document can\'t be used: it was not loaded' },
      );
    });

    it.each([
      ['Swagger 2.0', { swagger: '2.0', paths: {} }, 'Swagger 2.0 is not supported; use OpenAPI 3.0 or 3.1'],
      ['a document without a version', { paths: weatherOpenApi.paths }, 'it must be an OpenAPI 3.0 or 3.1 document'],
      ['a document without operations', { openapi: '3.1.0', paths: {} }, 'it has no operations'],
      ['a path item reference', { openapi: '3.0.3', paths: { '/a': { $ref: '#/components/pathItems/a' } } }, 'the path "/a" uses "$ref", which is not supported'],
      ['a non-string operationId', { openapi: '3.0.3', paths: { '/a': { get: { operationId: 7 } } } }, 'the operationId of GET /a must be a non-empty string'],
    ])('rejects %s', (_name, document, reason) => {
      expect(errors({}, { openapiDocuments: new Map([[weatherOpenApiUrl, document]]) })).toContainEqual(
        { path: '/upstreams/0/openapi', message: `the linked OpenAPI document can't be used: ${reason}` },
      );
    });

    it('rejects duplicate operationIds within an upstream', () => {
      const paths = { '/upload': { post: { operationId: 'uploadFile' } }, '/upload/{id}': { put: { operationId: 'uploadFile' } } };

      expect(errors({ upstreams: [mainUpstream, filesUpstream(paths)] })).toContainEqual(
        { path: '/upstreams/1/paths/~1upload~1{id}/put', message: 'duplicate operationId "uploadFile" in upstream "files"' },
      );
    });

    it('rejects paths that conflict across upstreams, ignoring parameter names', () => {
      const paths = { '/upload': { post: { operationId: 'uploadFile' } }, '/weather/{town}': { get: { operationId: 'weatherCopy' } } };

      expect(errors({ upstreams: [mainUpstream, filesUpstream(paths)] })).toEqual([
        { path: '/upstreams/1/paths/~1weather~1{town}/get', message: 'GET /weather/{town} conflicts with GET /weather/{city} in upstream "main"' },
      ]);
    });

    it('allows the same path with another method, and literal paths beside parameters', () => {
      const paths = { '/upload': { post: { operationId: 'uploadFile' } }, '/weather/{city}': { post: { operationId: 'reportWeather' } }, '/weather/today': { get: { operationId: 'today' } } };

      expect(validate({ upstreams: [mainUpstream, filesUpstream(paths)] }).ok).toBe(true);
    });
  });

  describe('routes (SR-6)', () => {
    it('resolves bare and prefixed route keys', () => {
      expect(validate({ routes: { 'main/getWeather': { payment: 'premium' }, getWeather: undefined } }).ok).toBe(true);
    });

    it.each([
      ['an unknown operationId', { routes: { getClimate: {} } }, '/routes/getClimate', 'no upstream has an operation with operationId "getClimate"'],
      ['an unknown prefixed operationId', { routes: { 'files/download': {} } }, '/routes/files~1download', 'upstream "files" has no operation with operationId "download"'],
      ['a prefix that names no upstream', { routes: { 'other/getWeather': {} } }, '/routes/other~1getWeather', 'no upstream has an operation with operationId "other/getWeather"'],
      ['an unknown named payment', { routes: { getWeather: { payment: 'gold' } } }, '/routes/getWeather/payment', 'is not a payment name. Payments: "default", "premium"'],
      ['a target parameter the operation lacks', { routes: { getForecast: { target: { path: '/internal/{town}' } } } }, '/routes/getForecast/target/path', 'uses {town}, which GET /forecast/{city} doesn\'t define'],
      ['a route configured twice', { routes: { 'main/getWeather': { enabled: false } } }, '/routes/main~1getWeather', 'configures the same operation as the route "getWeather"'],
    ])('rejects %s', (_name, changes, path, message) => {
      expect(errors(changes)).toContainEqual({ path, message });
    });

    it('asks for a prefix when an operationId is in several upstreams', () => {
      const paths = { '/upload': { post: { operationId: 'getWeather' } } };

      expect(errors({ upstreams: [mainUpstream, filesUpstream(paths)], routes: { 'files/uploadFile': undefined } })).toEqual([
        { path: '/routes/getWeather', message: 'several upstreams have this operationId; use "main/getWeather", "files/getWeather"' },
      ]);
      const { name: _name, ...unnamed } = filesUpstream(paths);
      expect(errors({ upstreams: [mainUpstream, unnamed], routes: { 'files/uploadFile': undefined } })).toContainEqual(
        { path: '/routes/getWeather', message: 'several upstreams have this operationId; name them and use <upstream>/<operationId>' },
      );
    });
  });

  describe('credentials', () => {
    it('rejects references to unknown credentials', () => {
      expect(errors({ upstreams: [{ ...mainUpstream, auth: 'missing-key' }, filesUpstream({ '/upload': { post: { operationId: 'uploadFile' } } })] })).toEqual([
        { path: '/upstreams/0/auth', message: 'is not a credential name. Credentials: "main-key", "files-key", "files-app"' },
      ]);
    });

    it('rejects two credentials that set the same header on one upstream', () => {
      const credentials = { 'files-app': { type: 'apiKey', in: 'header', name: 'x-api-key', secret: 'files-app-id' } };

      expect(errors({ credentials })).toEqual([
        { path: '/upstreams/1/auth/1', message: 'sets the x-api-key header, like the credential "files-key"' },
      ]);
    });

    it('rejects an API key in Authorization next to an HTTP credential', () => {
      const credentials = {
        'files-app': { type: 'http', scheme: 'basic', secret: 'files-app-id', in: undefined, name: undefined },
        'files-key': { name: 'Authorization' },
      };

      expect(errors({ credentials })).toEqual([
        { path: '/upstreams/1/auth/1', message: 'sets the Authorization header, like the credential "files-key"' },
      ]);
    });

    it('allows the same name in different places', () => {
      const credentials = { 'files-app': { type: 'apiKey', in: 'query', name: 'X-Api-Key', secret: 'files-app-id' } };

      expect(validate({ credentials }).ok).toBe(true);
    });

    it.each(['Host', 'Content-Length', 'X-Request-Id', 'Servicerouter-Buyer', 'Cookie'])('rejects a credential that sets %s', header => {
      expect(errors({ credentials: { 'files-key': { name: header } } })).toContainEqual(
        { path: '/credentials/files-key/name', message: `the platform sets ${header}; a credential can't` },
      );
    });
  });

  describe('warnings', () => {
    it('warns about unused payments and credentials without failing', () => {
      const result = validate({
        routes: { getWeather: undefined },
        credentials: { spare: { type: 'http', scheme: 'bearer', secret: 'spare' } },
      });

      expect(result).toMatchObject({
        ok: true,
        warnings: [
          { path: '/payments/premium', message: 'is not used by any route' },
          { path: '/credentials/spare', message: 'is not used by any upstream' },
        ],
      });
    });

    it('warns about secrets that are not set', () => {
      const result = validate({}, { secretNames: new Set(['weather-key']) });

      expect(result.warnings).toEqual([
        { path: '/credentials/files-key/secret', message: 'the secret "files-key" is not set. Send it with the config or set it through the secrets API' },
        { path: '/credentials/files-app/secret', message: 'the secret "files-app-id" is not set. Send it with the config or set it through the secrets API' },
      ]);
    });

    it('skips secret warnings when the secret names are unknown', () => {
      expect(validate({}, { secretNames: undefined }).warnings).toEqual([]);
    });

    it('returns warnings alongside errors', () => {
      const result = validate({ service: { category: 'sports' }, routes: { getWeather: undefined } });

      expect(result).toMatchObject({ ok: false, warnings: [{ path: '/payments/premium' }] });
    });
  });
});

describe('getOpenApiLinks', () => {
  it('lists each linked document once', () => {
    const config = patch(exampleServiceObject(), { upstreams: [mainUpstream, { ...mainUpstream, name: 'mirror', baseUrl: 'https://mirror.example.com' }] }) as unknown as ServiceConfigDocument;

    expect(getOpenApiLinks(config)).toEqual([weatherOpenApiUrl]);
  });
});
