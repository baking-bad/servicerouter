import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAddressPolicy, OutboundHttp, type ValidationIssue } from '@servicerouter/common';
import { createFakeResolver, createManualTimers, startFakeUpstream, type FakeResolver, type FakeUpstream, type ManualTimers } from '@servicerouter/testing';

import {
  fetchOpenApiDocuments, openApiFetchLimits, parseServiceConfig, validateServiceConfig, type FetchOpenApiDocumentsResult, type ParsedServiceConfig,
} from '../../src/index.js';
import { exampleContext, exampleServiceConfig, weatherOpenApi, weatherOpenApiUrl } from '../fixtures.js';

// The fake upstream listens on 127.0.0.1; only these tests may reach loopback
const loopbackPolicy = createAddressPolicy({ allow: ['127.0.0.0/8'] });
// Every failing response carries this. No issue may repeat it (SR-3, rule 10).
const bodyMarker = 'BODY-MARKER-do-not-echo';

let upstream: FakeUpstream;
let resolver: FakeResolver;
let timers: ManualTimers;
let http: OutboundHttp;

beforeEach(async () => {
  upstream = await startFakeUpstream({ hosts: ['api.example.com', 'other.example.com'] });
  timers = createManualTimers();
  resolver = createFakeResolver({ 'api.example.com': '127.0.0.1', 'other.example.com': '127.0.0.1', 'internal.example.com': '10.0.0.5' });
  http = new OutboundHttp({
    ownHosts: exampleContext.platform.ownHosts,
    resolver,
    addressPolicy: loopbackPolicy,
    ca: upstream.ca,
    timers,
    connectTimeoutMs: openApiFetchLimits.connectTimeoutMs,
  });
});

afterEach(async () => {
  await http.close();
  await upstream.close();
});

// The example config as text, with its OpenAPI link pointing at the fake upstream
const configText = (link = upstream.url('api.example.com', '/openapi.json')): string => exampleServiceConfig.replace(weatherOpenApiUrl, link);

const parsed = (text = configText()): ParsedServiceConfig => {
  const result = parseServiceConfig(text);
  if (!result.ok)
    throw new Error(JSON.stringify(result.errors));

  return result.parsed;
};

const errorsOf = (result: FetchOpenApiDocumentsResult): readonly ValidationIssue[] => {
  if (result.ok)
    throw new Error('Expected the fetch to fail');

  expect(JSON.stringify(result.errors)).not.toContain(bodyMarker);

  return result.errors;
};

// The issue at upstreams[0].openapi, with the position of the link in the example text
const linkLine = exampleServiceConfig.split('\n').findIndex(line => line.includes(weatherOpenApiUrl));
const linkPosition = { line: linkLine + 1, column: exampleServiceConfig.split('\n')[linkLine]!.indexOf(weatherOpenApiUrl) + 1 };
const linkIssue = (message: string): ValidationIssue => ({ path: '/upstreams/0/openapi', message, ...linkPosition });

const weatherYaml = `openapi: 3.1.0
info:
  title: Weather
  version: 1.0.0
paths:
  /weather/{city}:
    get:
      operationId: getWeather
      responses:
        200:
          description: OK
  /forecast/{city}:
    get:
      operationId: getForecast
  /admin/reset:
    post:
      operationId: adminReset
`;

describe('fetchOpenApiDocuments (SR-3)', () => {
  it('fetches a JSON document, ready for the semantic checks', async () => {
    upstream.handle((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(weatherOpenApi));
    });
    const config = parsed();

    const result = await fetchOpenApiDocuments(config, { http });

    expect(result).toEqual({ ok: true, documents: new Map([[upstream.url('api.example.com', '/openapi.json'), weatherOpenApi]]) });
    expect(upstream.requests).toMatchObject([{ method: 'GET', path: '/openapi.json' }]);
    expect(validateServiceConfig(configText(), { ...exampleContext, openapiDocuments: result.ok ? result.documents : new Map() }).ok).toBe(true);
  });

  it('fetches a YAML document', async () => {
    upstream.handle((_request, response) => {
      response.setHeader('content-type', 'application/yaml');
      response.end(weatherYaml);
    });

    expect(await fetchOpenApiDocuments(parsed(), { http })).toMatchObject({ ok: true, documents: new Map([[upstream.url('api.example.com', '/openapi.json'), weatherOpenApi]]) });
  });

  it('follows a redirect on the same host', async () => {
    upstream.handle((request, response) => {
      if (request.path === '/openapi.json')
        response.writeHead(302, { location: '/v2/openapi.json' }).end();
      else
        response.end(JSON.stringify(weatherOpenApi));
    });

    expect(await fetchOpenApiDocuments(parsed(), { http })).toMatchObject({ ok: true });
    expect(upstream.requests.map(request => request.path)).toEqual(['/openapi.json', '/v2/openapi.json']);
  });

  it('fetches different links concurrently, and a shared link once', async () => {
    const pending: (() => void)[] = [];
    upstream.handle((_request, response) => {
      // Answers only once both requests have arrived, so a sequential fetch would never finish
      pending.push(() => response.end(JSON.stringify(weatherOpenApi)));
      if (pending.length === 2)
        pending.forEach(respond => respond());
    });
    const first = upstream.url('api.example.com', '/one.json');
    const second = upstream.url('api.example.com', '/two.json');
    const text = configText(first)
      .replace('    paths:\n      /upload:\n        post:\n          operationId: uploadFile\n          summary: Upload a file\n', `    openapi: ${second}\n`);
    const twice = text.replace('upstreams:\n', `upstreams:\n  - baseUrl: https://third.example.com\n    name: third\n    openapi: ${first}\n`);

    const result = await fetchOpenApiDocuments(parsed(twice), { http });

    expect(result.ok && [...result.documents.keys()]).toEqual([first, second]);
    expect(upstream.requests.map(request => request.path).sort()).toEqual(['/one.json', '/two.json']);
  });

  it('refuses a redirect to another host', async () => {
    upstream.handle((_request, response) => {
      response.writeHead(302, { location: upstream.url('other.example.com', '/openapi.json') }).end(bodyMarker);
    });

    expect(errorsOf(await fetchOpenApiDocuments(parsed(), { http }))).toEqual([
      linkIssue('the linked OpenAPI document can\'t be fetched: api.example.com redirected to another host or to plain HTTP'),
    ]);
    expect(upstream.requests).toHaveLength(1);
  });

  it('refuses a document over the size limit, declared or streamed', async () => {
    const message = `the linked OpenAPI document can't be fetched: the response from api.example.com exceeds ${openApiFetchLimits.maxBytes} bytes`;
    upstream.handle((_request, response) => {
      response.end(Buffer.alloc(openApiFetchLimits.maxBytes + 1, bodyMarker));
    });

    expect(errorsOf(await fetchOpenApiDocuments(parsed(), { http }))).toEqual([linkIssue(message)]);

    upstream.handle((_request, response) => {
      const chunk = Buffer.alloc(1024 * 1024, bodyMarker);
      for (let index = 0; index < 6; index++)
        response.write(chunk);
      response.end();
    });

    expect(errorsOf(await fetchOpenApiDocuments(parsed(), { http }))).toEqual([linkIssue(message)]);
  });

  it('times out a slow upstream after the total limit', async () => {
    upstream.handle(() => undefined);
    const result = fetchOpenApiDocuments(parsed(), { http });
    await vi.waitFor(() => expect(upstream.requests).toHaveLength(1));

    timers.advance(openApiFetchLimits.totalTimeoutMs);

    expect(errorsOf(await result)).toEqual([
      linkIssue(`the linked OpenAPI document can't be fetched: the request to api.example.com timed out after ${openApiFetchLimits.totalTimeoutMs} ms`),
    ]);
  });

  it('refuses a host with a private address (OH-1)', async () => {
    const errors = errorsOf(await fetchOpenApiDocuments(parsed(configText('https://internal.example.com/openapi.json')), { http }));

    expect(errors).toEqual([linkIssue(expect.stringMatching(/^the linked OpenAPI document can't be fetched: internal\.example\.com resolves to /) as unknown as string)]);
    expect(upstream.requests).toEqual([]);
  });

  it('reports an unreachable host', async () => {
    expect(errorsOf(await fetchOpenApiDocuments(parsed(configText('https://nowhere.example.com/openapi.json')), { http }))).toEqual([
      linkIssue('the linked OpenAPI document can\'t be fetched: nowhere.example.com could not be resolved'),
    ]);
  });

  it('reports a link that is not HTTPS', async () => {
    const config = parsed();
    const [first, ...rest] = config.config.upstreams;
    const plain: ParsedServiceConfig = {
      config: { ...config.config, upstreams: [{ ...first!, openapi: 'http://api.example.com/openapi.json' }, ...rest] },
      document: undefined,
    };

    expect(errorsOf(await fetchOpenApiDocuments(plain, { http }))).toEqual([
      { path: '/upstreams/0/openapi', message: 'the linked OpenAPI document can\'t be fetched: only HTTPS URLs are allowed, not http' },
    ]);
  });

  it.each([404, 500])('reports a status %i without the body', async status => {
    upstream.handle((_request, response) => {
      response.writeHead(status, { 'content-type': 'text/html' }).end(`<h1>${bodyMarker}</h1>`);
    });

    expect(errorsOf(await fetchOpenApiDocuments(parsed(), { http }))).toEqual([
      linkIssue(`the linked OpenAPI document can't be fetched: api.example.com answered with status ${status}`),
    ]);
  });

  it.each([
    ['HTML', `<html><body>${bodyMarker}</body></html>`, 'the root must be a mapping'],
    ['broken JSON', `{"openapi": "3.1.0", "info": "${bodyMarker}"`, 'invalid YAML or JSON syntax at line 1'],
    ['a duplicate key', `openapi: 3.1.0\nopenapi: ${bodyMarker}\n`, 'duplicate key at line 2, column 1 of the document'],
  ])('reports a document that doesn\'t parse (%s) without its content', async (_name, body, reason) => {
    upstream.handle((_request, response) => {
      response.end(body);
    });

    const [issue] = errorsOf(await fetchOpenApiDocuments(parsed(), { http }));

    expect(issue).toMatchObject({ path: '/upstreams/0/openapi', ...linkPosition });
    expect(issue?.message).toMatch(/^the linked OpenAPI document doesn't parse as JSON or YAML: /);
    expect(issue?.message).toContain(reason);
  });
});
