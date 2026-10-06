import { describe, expect, it } from 'vitest';

import { compileServiceRuntime, normalizePathText, parseServiceConfig, type ServiceRuntime } from '../../src/index.js';
import { examplePlatform, exampleServiceObject } from '../fixtures.js';

const operation = (operationId: string) => ({ operationId });

// One inline upstream with the shapes the matcher must tell apart
const runtime: ServiceRuntime = (() => {
  const config = exampleServiceObject();
  config['upstreams'] = [{
    baseUrl: 'https://api.example.com',
    paths: {
      '/forecast/{city}': { get: operation('getForecast') },
      '/forecast/today': { get: operation('getToday') },
      '/items/{id}/details': { get: operation('getItemDetails') },
      '/items/special/other': { get: operation('getSpecialOther') },
      '/files/{name}': { get: operation('getFile') },
      '/files/{name}.json': { get: operation('getFileJson') },
      '/jobs/{job}:cancel': { post: operation('cancelJob') },
      '/head-only': { head: operation('headOnly') },
      '/get-only': { get: operation('getOnly') },
      '/disabled': { get: operation('disabledRoute') },
      '/café': { get: operation('getCafe') },
      '/': { get: operation('getRoot') },
    },
  }];
  config['routes'] = { disabledRoute: { enabled: false } };
  delete config['credentials'];
  const parsed = parseServiceConfig(config);
  if (!parsed.ok)
    throw new Error(JSON.stringify(parsed.errors));
  const result = compileServiceRuntime({
    serviceId: 'my-app', revision: 1, state: 'live', config: parsed.parsed.config, openapiDocuments: new Map(), platform: examplePlatform,
  });
  if (!result.ok)
    throw new Error(JSON.stringify(result.errors));

  return result.runtime;
})();

const matched = (method: string, path: string) => {
  const match = runtime.match(method, path.slice(1).split('/'));

  return match && { operationId: match.operation.docs.operationId, params: match.params };
};

describe('runtime.match (PX-4, PX-8)', () => {
  it('prefers a literal segment to a parameter (PX-4)', () => {
    expect(matched('GET', '/forecast/today')).toEqual({ operationId: 'getToday', params: {} });
    expect(matched('GET', '/forecast/oslo')).toEqual({ operationId: 'getForecast', params: { city: 'oslo' } });
  });

  it('falls back to a parameter when the literal branch has no match further on (PX-4)', () => {
    expect(matched('GET', '/items/special/other')).toEqual({ operationId: 'getSpecialOther', params: {} });
    expect(matched('GET', '/items/special/details')).toEqual({ operationId: 'getItemDetails', params: { id: 'special' } });
  });

  it('matches a parameter to exactly one non-empty segment', () => {
    expect(matched('GET', '/forecast/')).toBeUndefined();
    expect(matched('GET', '/forecast/oslo/extra')).toBeUndefined();
    expect(matched('GET', '/forecast')).toBeUndefined();
    expect(matched('GET', '/items//details')).toBeUndefined();
  });

  it('matches a parameter with literal text around it, before a bare parameter', () => {
    expect(matched('GET', '/files/report.json')).toEqual({ operationId: 'getFileJson', params: { name: 'report' } });
    expect(matched('GET', '/files/report')).toEqual({ operationId: 'getFile', params: { name: 'report' } });
    expect(matched('GET', '/files/.json')).toEqual({ operationId: 'getFile', params: { name: '.json' } });
    expect(matched('POST', '/jobs/42:cancel')).toEqual({ operationId: 'cancelJob', params: { job: '42' } });
  });

  it('never sends HEAD to a GET operation (PX-8)', () => {
    expect(matched('HEAD', '/get-only')).toBeUndefined();
    expect(matched('HEAD', '/forecast/oslo')).toBeUndefined();
    expect(matched('HEAD', '/head-only')).toMatchObject({ operationId: 'headOnly' });
    expect(matched('GET', '/head-only')).toBeUndefined();
  });

  it('matches a disabled route, with enabled: false (PX-4)', () => {
    expect(runtime.match('GET', ['disabled'])?.operation).toMatchObject({ enabled: false, docs: { operationId: 'disabledRoute' } });
  });

  it('returns undefined for an unknown path or method', () => {
    expect(matched('GET', '/unknown')).toBeUndefined();
    expect(matched('DELETE', '/forecast/oslo')).toBeUndefined();
    expect(matched('BREW', '/forecast/oslo')).toBeUndefined();
  });

  it('takes the method in any case', () => {
    expect(matched('get', '/forecast/oslo')).toMatchObject({ operationId: 'getForecast' });
  });

  it('matches the root path', () => {
    expect(matched('GET', '/')).toMatchObject({ operationId: 'getRoot' });
  });

  it('compares raw segments and keeps params percent-encoded', () => {
    expect(matched('GET', '/forecast/S%C3%A3o%20Paulo')).toEqual({ operationId: 'getForecast', params: { city: 'S%C3%A3o%20Paulo' } });
    expect(matched('GET', '/forecast/a%2Fb')).toEqual({ operationId: 'getForecast', params: { city: 'a%2Fb' } });
    expect(matched('GET', '/caf%C3%A9')).toMatchObject({ operationId: 'getCafe' });
    expect(matched('GET', `/${normalizePathText('café')}`)).toMatchObject({ operationId: 'getCafe' });
  });
});

describe('normalizePathText', () => {
  it.each([
    ['café', 'caf%C3%A9'],
    ['caf%c3%a9', 'caf%C3%A9'],
    ['%41b%7e', 'Ab~'],
    ['a b', 'a%20b'],
    ['a%2fb', 'a%2Fb'],
    ['100%', '100%25'],
    ['%zz', '%25zz'],
    ['a:b@c!$&\'()*+,;=-._~', 'a:b@c!$&\'()*+,;=-._~'],
    ['"<>`', '%22%3C%3E%60'],
  ])('%j → %j', (text, normalized) => {
    expect(normalizePathText(text)).toBe(normalized);
  });
});
