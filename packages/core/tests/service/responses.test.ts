import { describe, expect, it } from 'vitest';

import { compileServiceRuntime, declaresStatus, operationsFromPaths, type RuntimeOperation } from '../../src/index.js';
import { exampleContext, exampleServiceObject, patch, weatherOpenApi, weatherOpenApiUrl } from '../fixtures.js';

const withResponses = (responses: readonly string[]): Pick<RuntimeOperation, 'responses'> => ({ responses });

describe('declared responses (PX-7)', () => {
  it('lists the keys of an operation\'s responses: codes, ranges in one case, and default, ignoring anything else', () => {
    const result = operationsFromPaths({
      '/a': { get: { responses: { 200: {}, '4xx': {}, default: {}, 'x-note': {}, 600: {}, 20: {} } } },
      '/b': { get: {} },
      '/c': { get: { responses: 'none' } },
    });

    expect(result.ok && result.operations.map(operation => operation.responses)).toEqual([['200', '4XX', 'default'], [], []]);
  });

  it('carries them into the runtime', () => {
    const documents = new Map([[weatherOpenApiUrl, patch(weatherOpenApi, { paths: { '/forecast/{city}': { get: { responses: { 200: {}, 404: {} } } } } })]]);
    const result = compileServiceRuntime({
      serviceId: 'my-app',
      revision: 1,
      state: 'live',
      config: exampleServiceObject() as never,
      openapiDocuments: documents,
      platform: exampleContext.platform,
    });

    expect(result.ok && result.runtime.operations.map(operation => [operation.routeKey, operation.responses])).toEqual([
      ['getWeather', ['200']],
      ['getForecast', ['200', '404']],
      ['adminReset', []],
      ['uploadFile', []],
    ]);
  });

  it.each([
    [['200'], 200, true],
    [['200'], 201, false],
    [['2XX'], 204, true],
    [['2XX'], 302, false],
    [['302', '404'], 404, true],
    [['default'], 503, true],
    [[], 200, false],
  ] as const)('with %j declares %i: %s', (responses, status, expected) => {
    expect(declaresStatus(withResponses(responses), status)).toBe(expected);
  });
});
