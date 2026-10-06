import { describe, expect, it } from 'vitest';

import { Secret } from '@servicerouter/common';
import type { CredentialReference, OperationMatch, RuntimeOperation, RuntimeUpstream } from '@servicerouter/core';

import {
  buildUpstreamRequest, createSelfLinkRewriter, filterResponseHeaders, rewriteLinkHeader,
} from '../../src/services/forward.js';

const upstream: RuntimeUpstream = { name: 'main', baseUrl: 'https://api.example.com/v2', origin: 'https://api.example.com', pathPrefix: '/v2' };

const operation = (credentials: readonly CredentialReference[] = []): RuntimeOperation => ({
  routeKey: 'getForecast',
  method: 'get',
  path: '/forecast/{city}',
  upstream,
  target: '/internal/forecast/{city}',
  price: 0n,
  enabled: true,
  credentials,
  responses: ['200'],
  docs: { operationId: 'getForecast', summary: undefined, description: undefined, bazaar: undefined },
});

const match = (credentials?: readonly CredentialReference[]): OperationMatch => ({ operation: operation(credentials), params: { city: 'S%C3%A3o%20Paulo' } });
const secrets = (values: Record<string, string>) => new Map(Object.entries(values).map(([name, value]) => [name, Secret.from(value)]));

describe('the request to the upstream (PX-5)', () => {
  it('keeps only the allowlisted client headers, adds the request ID, and rewrites the path with the prefix', () => {
    const request = buildUpstreamRequest({
      match: match(),
      query: 'units=metric',
      requestId: 'req-1',
      secrets: new Map(),
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip',
        'content-type': 'application/json',
        'content-length': '12',
        'idempotency-key': 'k-1',
        authorization: 'Bearer sr_test_buyer',
        cookie: 'session=1',
        'x-payment': 'paid',
        'payment-signature': 'sig',
        'x-forwarded-for': '203.0.113.7',
        host: 'pay.servicerouter.ai',
        'x-request-id': 'spoofed',
      },
    });

    expect(request).toEqual({
      url: 'https://api.example.com/v2/internal/forecast/S%C3%A3o%20Paulo?units=metric',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip',
        'content-type': 'application/json',
        'idempotency-key': 'k-1',
        'x-request-id': 'req-1',
      },
    });
  });

  it('applies a bearer credential after filtering, over the client\'s Authorization', () => {
    const request = buildUpstreamRequest({
      match: match([{ credential: 'main', apply: { type: 'bearer' }, secretName: 'main-key' }]),
      query: '',
      requestId: 'req-1',
      secrets: secrets({ 'main-key': 'sk-live-1' }),
      headers: { authorization: 'Bearer sr_test_buyer' },
    });

    expect(request.headers['authorization']).toBe('Bearer sk-live-1');
    expect(request.url).toBe('https://api.example.com/v2/internal/forecast/S%C3%A3o%20Paulo');
  });

  it('applies a basic credential as base64 of user:password', () => {
    const request = buildUpstreamRequest({
      match: match([{ credential: 'main', apply: { type: 'basic' }, secretName: 'login' }]),
      query: '',
      requestId: 'req-1',
      secrets: secrets({ login: 'user:pa ss' }),
      headers: {},
    });

    expect(request.headers['authorization']).toBe(`Basic ${Buffer.from('user:pa ss').toString('base64')}`);
  });

  it('applies API keys in a header, the query, and cookies, all of them, over the client\'s own', () => {
    const request = buildUpstreamRequest({
      match: match([
        { credential: 'header', apply: { type: 'apiKey', in: 'header', name: 'X-Api-Key' }, secretName: 'header-key' },
        { credential: 'query', apply: { type: 'apiKey', in: 'query', name: 'api_key' }, secretName: 'query-key' },
        { credential: 'cookie', apply: { type: 'apiKey', in: 'cookie', name: 'sid' }, secretName: 'cookie-key' },
        { credential: 'app', apply: { type: 'apiKey', in: 'cookie', name: 'app' }, secretName: 'app-id' },
      ]),
      query: 'units=metric&api_key=buyer-chosen&api%5Fkey=encoded&q=a+b',
      requestId: 'req-1',
      secrets: secrets({ 'header-key': 'h&1', 'query-key': 'q 1/=', 'cookie-key': 'c1', 'app-id': 'a1' }),
      headers: { 'x-api-key': 'buyer', cookie: 'sid=buyer' },
    });

    expect(request.headers['x-api-key']).toBe('h&1');
    expect(request.headers['cookie']).toBe('sid=c1; app=a1');
    expect(request.url).toBe('https://api.example.com/v2/internal/forecast/S%C3%A3o%20Paulo?units=metric&q=a+b&api_key=q%201%2F%3D');
  });
});

describe('self-links in upstream headers (PX-6, PX-10)', () => {
  const rewrite = createSelfLinkRewriter({
    payUrl: 'https://pay.servicerouter.ai',
    serviceId: 'my-app',
    upstream,
    requestUrl: new URL('https://api.example.com/v2/internal/forecast/oslo'),
  });

  it.each([
    ['an absolute URL under the base URL', 'https://api.example.com/v2/weather/oslo?units=metric#now', 'https://pay.servicerouter.ai/service/my-app/weather/oslo?units=metric#now'],
    ['the base URL itself', 'https://api.example.com/v2', 'https://pay.servicerouter.ai/service/my-app/'],
    ['a path on the upstream', '/v2/jobs/7', 'https://pay.servicerouter.ai/service/my-app/jobs/7'],
    ['a relative reference', 'oslo/hourly', 'https://pay.servicerouter.ai/service/my-app/internal/forecast/oslo/hourly'],
    ['another origin, kept as it is', 'https://cdn.example.net/file.png', 'https://cdn.example.net/file.png'],
    ['the upstream outside its prefix, dropped', 'https://api.example.com/admin', undefined],
    ['the upstream on a path that only starts like the prefix, dropped', 'https://api.example.com/v20/x', undefined],
    ['the upstream over plain HTTP, kept: another origin', 'http://api.example.com/v2/x', 'http://api.example.com/v2/x'],
  ])('handles %s', (_case, value, expected) => {
    expect(rewrite(value)).toBe(expected);
  });

  it('builds links from the canonical pay URL, never the request\'s host (PX-10)', () => {
    const withSlash = createSelfLinkRewriter({ payUrl: 'https://pay.servicerouter.ai/', serviceId: 'my-app', upstream, requestUrl: new URL('https://api.example.com/v2/') });

    expect(withSlash('/v2/x')).toBe('https://pay.servicerouter.ai/service/my-app/x');
  });

  it('rewrites each link in a Link header, keeps their parameters, and drops those that would reveal the upstream', () => {
    const value = '<https://api.example.com/v2/items?page=2>; rel="next", <https://api.example.com/private>; rel="admin", '
      + '<https://docs.example.net/a,b>; rel="help"; title="x, y"';

    expect(rewriteLinkHeader(value, rewrite)).toBe('<https://pay.servicerouter.ai/service/my-app/items?page=2>; rel="next", '
      + '<https://docs.example.net/a,b>; rel="help"; title="x, y"');
    expect(rewriteLinkHeader('<https://api.example.com/private>; rel="x"', rewrite)).toBeUndefined();
  });

  it('passes only the allowlisted response headers, never Set-Cookie, and rewrites the self-links', () => {
    const headers = filterResponseHeaders({
      'content-type': 'application/json',
      'content-length': '12',
      etag: '"v1"',
      'set-cookie': ['session=upstream'],
      server: 'nginx/1.2.3',
      'x-powered-by': 'Express',
      'access-control-allow-origin': 'https://evil.example',
      location: 'https://api.example.com/v2/weather/oslo',
      'content-location': 'https://api.example.com/secret',
      link: '<https://api.example.com/v2/a>; rel="next"',
    }, rewrite);

    expect(headers).toEqual({
      'content-type': 'application/json',
      'content-length': '12',
      etag: '"v1"',
      location: 'https://pay.servicerouter.ai/service/my-app/weather/oslo',
      link: '<https://pay.servicerouter.ai/service/my-app/a>; rel="next"',
    });
  });
});
