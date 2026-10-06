import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeResolver, createManualTimers, startFakeUpstream, type FakeResolver, type FakeUpstream, type ManualTimers } from '@servicerouter/testing';

import {
  AddressPolicyNotAllowedError, BlockedAddressError, ConnectionFailedError, createAddressPolicy, DnsLookupError, OutboundHttp,
  OutboundTimeoutError, OwnHostError, RedirectNotAllowedError, RequestTooLargeError, ResponseTooLargeError, UrlNotAllowedError,
  type OutboundHttpOptions,
} from '../../src/index.js';

// The fake upstream listens on 127.0.0.1; only these tests may reach loopback
const loopbackPolicy = createAddressPolicy({ allow: ['127.0.0.0/8'] });
const ownHosts = ['pay.servicerouter.ai', 'api.servicerouter.ai', '203.0.113.7'];

let upstream: FakeUpstream;
let resolver: FakeResolver;
let timers: ManualTimers;
const clients: OutboundHttp[] = [];

const client = (options: Partial<OutboundHttpOptions> = {}): OutboundHttp => {
  const http = new OutboundHttp({ ownHosts, resolver, addressPolicy: loopbackPolicy, ca: upstream.ca, timers, ...options });
  clients.push(http);

  return http;
};

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  }
  catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
};

beforeEach(async () => {
  upstream = await startFakeUpstream({ hosts: ['api.example.com', 'other.example.com'] });
  timers = createManualTimers();
  resolver = createFakeResolver({
    'api.example.com': '127.0.0.1',
    'other.example.com': '127.0.0.1',
    'nocert.example.com': '127.0.0.1',
    'internal.example.com': '10.0.0.5',
    'metadata.example.com': '169.254.169.254',
    'mapped.example.com': '::ffff:10.0.0.5',
    'mixed.example.com': ['127.0.0.1', '10.0.0.5'],
    'platform-ip.example.com': '203.0.113.7',
    'nothing.example.com': [],
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(clients.splice(0).map(http => http.close()));
  await upstream.close();
});

describe('OutboundHttp', () => {
  describe('requests', () => {
    it('fetches over HTTPS with SNI and Host set to the hostname (OH-2)', async () => {
      const response = await client().request({ url: upstream.url('api.example.com', '/v1/weather?city=Oslo'), redirect: 'none' });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
      expect(upstream.requests).toMatchObject([{
        method: 'GET',
        path: '/v1/weather?city=Oslo',
        headers: { host: `api.example.com:${upstream.port}` },
        servername: 'api.example.com',
      }]);
    });

    it('sends the method, headers, and body, and drops a caller\'s Host header', async () => {
      const response = await client().request({
        url: upstream.url('api.example.com', '/upload'),
        method: 'post',
        headers: { 'Host': 'evil.example.com', 'x-custom': 'yes', 'accept': ['text/plain', 'application/json'], 'content-type': 'text/plain' },
        body: 'hello',
        redirect: 'none',
      });
      response.dispose();

      expect(upstream.requests[0]).toMatchObject({
        method: 'POST',
        headers: { 'host': `api.example.com:${upstream.port}`, 'x-custom': 'yes', 'accept': 'text/plain, application/json' },
      });
      expect(upstream.requests[0]?.body.toString()).toBe('hello');
    });

    it('resolves once per connection and keeps connections alive per origin (OH-2, OH-8)', async () => {
      const http = client();
      for (let index = 0; index < 3; index += 1) {
        await (await http.request({ url: upstream.url('api.example.com'), redirect: 'none' })).text();
        await new Promise(resolve => setImmediate(resolve));
      }

      expect(upstream.requests).toHaveLength(3);
      expect(upstream.connections).toBe(1);
      expect(resolver.lookups).toEqual(['api.example.com']);
    });

    it('returns a non-2xx response as is', async () => {
      upstream.handle((_request, response) => {
        response.writeHead(503, { 'retry-after': '5' }).end('busy');
      });
      const response = await client().request({ url: upstream.url('api.example.com'), redirect: 'none' });

      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('5');
      expect(await response.text()).toBe('busy');
    });
  });

  describe('address checks (OH-1)', () => {
    it.each([
      ['a private address', 'internal.example.com', '10.0.0.5', 'internal.example.com resolves to a private address'],
      ['a cloud metadata address', 'metadata.example.com', '169.254.169.254', 'metadata.example.com resolves to a cloud metadata address'],
      ['an IPv4-mapped private address', 'mapped.example.com', '::ffff:10.0.0.5', 'mapped.example.com resolves to a private address'],
      ['a mix of public and private addresses', 'mixed.example.com', '10.0.0.5', 'mixed.example.com resolves to a private address'],
    ])('refuses a host that resolves to %s, before connecting', async (_name, hostname, address, message) => {
      const error = await rejection(client().request({ url: upstream.url(hostname), redirect: 'none' }));

      expect(error).toBeInstanceOf(BlockedAddressError);
      expect(error).toMatchObject({ code: 'blocked_address', host: hostname, address, message });
      expect(upstream.connections).toBe(0);
    });

    it('refuses loopback with the production policy', async () => {
      const error = await rejection(client({ addressPolicy: undefined }).request({ url: upstream.url('api.example.com'), redirect: 'none' }));

      expect(error).toMatchObject({ code: 'blocked_address', message: 'api.example.com resolves to a loopback address' });
      expect(upstream.connections).toBe(0);
    });

    it.each([
      ['https://10.0.0.1/', 'a private address'],
      ['https://[::1]/', 'a loopback address'],
      ['https://[::ffff:169.254.169.254]/', 'a cloud metadata address'],
      ['https://2130706433/', 'a loopback address'],
      ['https://0x7f.1/', 'a loopback address'],
    ])('refuses the IP address in %s without a lookup', async (url, reason) => {
      const error = await rejection(client({ addressPolicy: undefined }).request({ url, redirect: 'none' }));

      expect(error).toBeInstanceOf(BlockedAddressError);
      expect((error as Error).message).toContain(reason);
      expect(resolver.lookups).toEqual([]);
    });

    it('fails when the host doesn\'t resolve', async () => {
      expect(await rejection(client().request({ url: 'https://unknown.example.com/', redirect: 'none' }))).toBeInstanceOf(DnsLookupError);
      expect(await rejection(client().request({ url: 'https://nothing.example.com/', redirect: 'none' }))).toBeInstanceOf(DnsLookupError);
    });
  });

  describe('platform hosts (OH-5)', () => {
    it.each(['pay.servicerouter.ai', 'evil.pay.servicerouter.ai', 'PAY.ServiceRouter.ai.'])('refuses %s without a lookup', async hostname => {
      const error = await rejection(client().request({ url: `https://${hostname}/`, redirect: 'none' }));

      expect(error).toBeInstanceOf(OwnHostError);
      expect(error).toMatchObject({ code: 'own_host' });
      expect(resolver.lookups).toEqual([]);
    });

    it('refuses hosts that resolve to a platform address, and platform IP addresses', async () => {
      expect(await rejection(client().request({ url: 'https://platform-ip.example.com/', redirect: 'none' }))).toBeInstanceOf(OwnHostError);
      expect(await rejection(client().request({ url: 'https://203.0.113.7/', redirect: 'none' }))).toBeInstanceOf(OwnHostError);
    });

    it('allows a host that only ends with a platform name', async () => {
      resolver.set('notpay.servicerouter.ai.example.com', '10.0.0.1');

      expect(await rejection(client().request({ url: 'https://notpay.servicerouter.ai.example.com/', redirect: 'none' }))).toBeInstanceOf(BlockedAddressError);
    });
  });

  describe('URLs and TLS (OH-6)', () => {
    it.each([
      ['plain HTTP', 'http://api.example.com/'],
      ['another protocol', 'ftp://api.example.com/'],
      ['credentials', 'https://user:secret@api.example.com/'],
      ['an invalid URL', 'not a url'],
    ])('refuses %s', async (_name, url) => {
      expect(await rejection(client().request({ url, redirect: 'none' }))).toBeInstanceOf(UrlNotAllowedError);
      expect(resolver.lookups).toEqual([]);
    });

    it('verifies the certificate against the hostname', async () => {
      const error = await rejection(client().request({ url: upstream.url('nocert.example.com'), redirect: 'none' }));

      expect(error).toBeInstanceOf(ConnectionFailedError);
      expect((error as Error).cause).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    });

    it('trusts only the configured CAs', async () => {
      const error = await rejection(client({ ca: undefined }).request({ url: upstream.url('api.example.com'), redirect: 'none' }));

      expect(error).toBeInstanceOf(ConnectionFailedError);
      expect(upstream.requests).toHaveLength(0);
    });

    it('names the host in errors, never the path or query', async () => {
      const error = await rejection(client().request({ url: 'https://internal.example.com/v1/data?api_key=DO_NOT_LOG', redirect: 'none' }));

      expect(JSON.stringify(error)).not.toContain('DO_NOT_LOG');
      expect((error as Error).message).not.toContain('/v1/data');
    });
  });

  describe('redirects (OH-3)', () => {
    const redirectTo = (location: string, status = 302) => {
      upstream.handle((request, response) => {
        if (request.path === '/start')
          response.writeHead(status, { location }).end();
        else
          response.end(`landed on ${request.method} ${request.path} with "${request.body.toString()}"`);
      });
    };

    it('returns redirects to the caller with redirect: none', async () => {
      redirectTo(upstream.url('other.example.com', '/elsewhere'));
      const response = await client().request({ url: upstream.url('api.example.com', '/start'), redirect: 'none' });
      response.dispose();

      expect(response.status).toBe(302);
      expect(response.headers['location']).toBe(upstream.url('other.example.com', '/elsewhere'));
      expect(upstream.requests).toHaveLength(1);
    });

    it('follows redirects on the same host with redirect: sameHost', async () => {
      redirectTo('/next?page=2', 301);
      const response = await client().request({ url: upstream.url('api.example.com', '/start'), redirect: 'sameHost' });

      expect(response.status).toBe(200);
      expect(response.url.toString()).toBe(upstream.url('api.example.com', '/next?page=2'));
      expect(await response.text()).toBe('landed on GET /next?page=2 with ""');
    });

    it.each([
      ['another host', () => upstream.url('other.example.com', '/next')],
      ['another port', () => `https://api.example.com:${upstream.port + 1}/next`],
      ['plain HTTP', () => `http://api.example.com:${upstream.port}/next`],
    ])('refuses a redirect to %s', async (_name, location) => {
      redirectTo(location());
      const error = await rejection(client().request({ url: upstream.url('api.example.com', '/start'), redirect: 'sameHost' }));

      expect(error).toBeInstanceOf(RedirectNotAllowedError);
      expect(upstream.requests).toHaveLength(1);
    });

    it('stops after the redirect limit', async () => {
      upstream.handle((_request, response) => {
        response.writeHead(302, { location: '/again' }).end();
      });
      const error = await rejection(client({ maxRedirects: 2 }).request({ url: upstream.url('api.example.com', '/again'), redirect: 'sameHost' }));

      expect(error).toMatchObject({ code: 'redirect_not_allowed', message: 'api.example.com redirected more than 2 times' });
      expect(upstream.requests).toHaveLength(3);
    });

    it('continues a POST as GET after 303, without the body', async () => {
      redirectTo('/next', 303);
      const response = await client().request({
        url: upstream.url('api.example.com', '/start'), method: 'POST', body: 'data', headers: { 'content-type': 'text/plain' }, redirect: 'sameHost',
      });

      expect(await response.text()).toBe('landed on GET /next with ""');
      expect(upstream.requests[1]?.headers['content-type']).toBeUndefined();
    });

    it('keeps the method and body after 307', async () => {
      redirectTo('/next', 307);
      const response = await client().request({ url: upstream.url('api.example.com', '/start'), method: 'POST', body: 'data', redirect: 'sameHost' });

      expect(await response.text()).toBe('landed on POST /next with "data"');
    });

    it('refuses to resend a streamed body', async () => {
      redirectTo('/next', 307);
      const error = await rejection(client().request({
        url: upstream.url('api.example.com', '/start'), method: 'PUT', body: Readable.from([Buffer.from('data')]), redirect: 'sameHost',
      }));

      expect(error).toBeInstanceOf(RedirectNotAllowedError);
    });
  });

  describe('size limits (OH-4)', () => {
    it('refuses a request body over the limit before connecting', async () => {
      const error = await rejection(client({ maxRequestBytes: 10 }).request({ url: upstream.url('api.example.com'), method: 'POST', body: Buffer.alloc(11), redirect: 'none' }));

      expect(error).toBeInstanceOf(RequestTooLargeError);
      expect(upstream.connections).toBe(0);
    });

    it('accepts a request body at the limit', async () => {
      const response = await client({ maxRequestBytes: 10 }).request({ url: upstream.url('api.example.com'), method: 'POST', body: 'x'.repeat(10), redirect: 'none' });

      expect(response.status).toBe(200);
      response.dispose();
    });

    it('stops a streamed request body over the limit', async () => {
      const body = Readable.from([Buffer.alloc(6), Buffer.alloc(6)]);
      const error = await rejection(client().request({ url: upstream.url('api.example.com'), method: 'POST', body, maxRequestBytes: 10, redirect: 'none' }));

      expect(error).toBeInstanceOf(RequestTooLargeError);
    });

    it('refuses a response whose Content-Length is over the limit', async () => {
      upstream.handle((_request, response) => {
        response.writeHead(200, { 'content-length': 100 }).end(Buffer.alloc(100));
      });

      expect(await rejection(client().request({ url: upstream.url('api.example.com'), maxResponseBytes: 99, redirect: 'none' }))).toBeInstanceOf(ResponseTooLargeError);
    });

    it('stops a streamed response at the limit', async () => {
      upstream.handle((_request, response) => {
        response.write(Buffer.alloc(8));
        response.end(Buffer.alloc(8));
      });
      const response = await client({ maxResponseBytes: 10 }).request({ url: upstream.url('api.example.com'), redirect: 'none' });

      expect(await rejection(response.bytes())).toBeInstanceOf(ResponseTooLargeError);
      expect(timers.pending).toBe(0);
    });

    it('reads a response at the limit', async () => {
      upstream.handle((_request, response) => {
        response.end(Buffer.alloc(10));
      });
      const response = await client({ maxResponseBytes: 10 }).request({ url: upstream.url('api.example.com'), redirect: 'none' });

      expect(await response.bytes()).toHaveLength(10);
    });
  });

  describe('deadlines (OH-4)', () => {
    it('fails at the total deadline while waiting for the response', async () => {
      let received!: () => void;
      const arrived = new Promise<void>(resolve => {
        received = resolve;
      });
      upstream.handle(() => received());
      const result = client({ totalTimeoutMs: 30_000 }).request({ url: upstream.url('api.example.com'), redirect: 'none' });

      await arrived;
      timers.advance(29_999);
      expect(timers.pending).toBe(1);
      timers.advance(1);

      const error = await rejection(result);
      expect(error).toBeInstanceOf(OutboundTimeoutError);
      expect(error).toMatchObject({ phase: 'total', timeoutMs: 30_000, message: 'The request to api.example.com timed out after 30000 ms' });
    });

    it('covers reading the body', async () => {
      upstream.handle((_request, response) => {
        response.writeHead(200).write('partial');
      });
      const response = await client().request({ url: upstream.url('api.example.com'), totalTimeoutMs: 5_000, redirect: 'none' });
      const reading = rejection(response.text());
      timers.advance(5_000);

      expect(await reading).toMatchObject({ code: 'outbound_timeout', phase: 'total' });
    });

    it('clears the deadline once the body is read or the request fails', async () => {
      const http = client();
      await (await http.request({ url: upstream.url('api.example.com'), redirect: 'none' })).text();
      await rejection(http.request({ url: upstream.url('internal.example.com'), redirect: 'none' }));

      expect(timers.pending).toBe(0);
    });

    it('stops when the caller aborts', async () => {
      upstream.handle(() => undefined);
      const controller = new AbortController();
      const result = client().request({ url: upstream.url('api.example.com'), redirect: 'none', signal: controller.signal });
      controller.abort(new Error('client went away'));

      expect(await rejection(result)).toMatchObject({ message: 'client went away' });
      expect(timers.pending).toBe(0);
    });

    it('doesn\'t start when the caller has already aborted', async () => {
      const error = await rejection(client().request({ url: upstream.url('api.example.com'), redirect: 'none', signal: AbortSignal.abort(new Error('early')) }));

      expect(error).toMatchObject({ message: 'early' });
      expect(resolver.lookups).toEqual([]);
    });
  });

  describe('failures', () => {
    it('reports a dropped connection as ConnectionFailedError', async () => {
      upstream.handle((_request, response) => {
        response.socket?.destroy();
      });

      expect(await rejection(client().request({ url: upstream.url('api.example.com'), redirect: 'none' }))).toBeInstanceOf(ConnectionFailedError);
    });
  });

  describe('production wiring (OH-7)', () => {
    it('refuses any address policy but the public one in production', () => {
      vi.stubEnv('NODE_ENV', 'production');

      expect(() => new OutboundHttp({ ownHosts, addressPolicy: loopbackPolicy })).toThrow(AddressPolicyNotAllowedError);
      expect(() => client({ addressPolicy: undefined })).not.toThrow();
    });
  });
});
