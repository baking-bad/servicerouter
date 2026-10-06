import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeIdGenerator } from '@servicerouter/testing';

import {
  createLogger, createMetricsServer, createServer, createShutdownHandler, ServiceRouterError, type Server,
  type ServerOptions,
} from '../../src/index.js';
import { captureLogs } from './helpers.js';

class PaymentRequiredError extends ServiceRouterError {
  readonly code = 'insufficient_balance';
}

class UnmappedError extends ServiceRouterError {
  readonly code = 'something_internal';
}

const silentLogger = createLogger({ level: 'silent' });
const servers: Server[] = [];

const buildServer = (options: Partial<ServerOptions> = {}): Server => {
  const server = createServer({ logger: silentLogger, errorStatuses: { insufficient_balance: 402 }, ...options });
  servers.push(server);

  return server;
};

const listen = (server: Server) => server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

// A plain HTTP GET on a new connection, so no request reuses another's socket
const get = (port: number, path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const request = httpRequest({ host: '127.0.0.1', port, path, agent: false }, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      body += chunk;
    });
    response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
  });
  request.on('error', reject);
  request.end();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
});

describe('request ID (XC-5)', () => {
  it('keeps a valid incoming x-request-id and returns it', async () => {
    const { app } = buildServer();

    const response = await app.inject({ method: 'GET', url: '/_/health', headers: { 'x-request-id': 'abc-123' } });

    expect(response.headers['x-request-id']).toBe('abc-123');
  });

  it('generates one when the request has none', async () => {
    const { app } = buildServer({ requestIds: createFakeIdGenerator('req-') });

    const response = await app.inject({ method: 'GET', url: '/_/health' });

    expect(response.headers['x-request-id']).toBe('req-1');
  });

  it.each([
    ['spaces', 'abc 123'],
    ['a newline', 'abc\n123'],
    ['over 128 characters', 'a'.repeat(129)],
    ['an empty value', ''],
  ])('replaces an incoming ID with %s', async (_case, value) => {
    const { app } = buildServer({ requestIds: createFakeIdGenerator('req-') });

    const response = await app.inject({ method: 'GET', url: '/_/health', headers: { 'x-request-id': value } });

    expect(response.headers['x-request-id']).toBe('req-1');
  });

  it('carries it on every log line of the request, and on error and 404 responses', async () => {
    const { logger, lines } = captureLogs();
    const { app } = buildServer({ logger });
    app.get('/work', async request => {
      request.log.info('inside the handler');

      return { ok: true };
    });
    app.get('/fail', async () => {
      throw new Error('boom');
    });

    const work = await app.inject({ method: 'GET', url: '/work', headers: { 'x-request-id': 'abc-123' } });
    const failed = await app.inject({ method: 'GET', url: '/fail', headers: { 'x-request-id': 'def-456' } });
    const missing = await app.inject({ method: 'GET', url: '/missing', headers: { 'x-request-id': 'ghi-789' } });

    expect([work, failed, missing].map(response => response.headers['x-request-id'])).toEqual(['abc-123', 'def-456', 'ghi-789']);
    expect(lines.filter(line => line['requestId'] === 'abc-123').map(line => line['msg'])).toEqual(['inside the handler', 'Request completed']);
    expect(lines.filter(line => line['requestId'] === 'def-456').map(line => line['msg'])).toEqual(['Request failed', 'Request completed']);
    expect(lines.filter(line => line['requestId'] === 'ghi-789').map(line => line['msg'])).toEqual(['Request completed']);
  });
});

describe('request log (XC-1, XC-7, CK-3)', () => {
  it('writes one line per request with metadata only: no URL, query, headers, body, or client address', async () => {
    const { logger, lines } = captureLogs();
    const { app } = buildServer({ logger });
    app.post('/items/:id', async () => ({ stored: true }));

    await app.inject({
      method: 'POST',
      url: '/items/item-1?key=query-secret',
      headers: { 'authorization': 'Bearer header-secret', 'x-request-id': 'abc-123', 'cookie': 'session=cookie-secret' },
      payload: { note: 'body-secret' },
    });

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      level: 30,
      msg: 'Request completed',
      requestId: 'abc-123',
      method: 'POST',
      route: '/items/:id',
      status: 200,
      requestBytes: 22,
      responseBytes: 15,
    });
    expect(line!['durationMs']).toBeTypeOf('number');
    expect(Object.keys(line!).sort()).toEqual([
      'durationMs', 'hostname', 'level', 'method', 'msg', 'pid', 'requestBytes', 'requestId', 'responseBytes', 'route', 'status', 'time',
    ]);
    const logged = JSON.stringify(lines);
    for (const secret of ['query-secret', 'header-secret', 'cookie-secret', 'body-secret', 'item-1', '127.0.0.1'])
      expect(logged).not.toContain(secret);
  });

  it('logs an unknown route without its URL', async () => {
    const { logger, lines } = captureLogs();
    const { app } = buildServer({ logger });

    await app.inject({ method: 'GET', url: '/sr_test_key-in-path?token=query-secret' });

    expect(lines).toEqual([expect.objectContaining({ route: 'unmatched', status: 404 })]);
    expect(JSON.stringify(lines)).not.toMatch(/sr_test_key-in-path|query-secret/);
  });
});

describe('errors (CK-2, PA-3, XC-7)', () => {
  it('answers a ServiceRouterError with its code, message, and the status from the app\'s table', async () => {
    const { app } = buildServer();
    app.get('/pay', async () => {
      throw new PaymentRequiredError('Credits don\'t cover the price');
    });

    const response = await app.inject({ method: 'GET', url: '/pay' });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toEqual({ error: { code: 'insufficient_balance', message: 'Credits don\'t cover the price' } });
  });

  it('answers a code missing from the table with an opaque 500', async () => {
    const { app } = buildServer();
    app.get('/internal', async () => {
      throw new UnmappedError('Redis at 10.0.0.5 refused the connection');
    });

    const response = await app.inject({ method: 'GET', url: '/internal' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  it('answers a plain Error with an opaque 500 internal_error, and logs it with its stack', async () => {
    const { logger, lines } = captureLogs();
    const { app } = buildServer({ logger });
    app.get('/boom', async () => {
      throw new Error('upstream 10.0.0.5 said: secret detail');
    });

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
    expect(response.body).not.toMatch(/secret detail|10\.0\.0\.5|stack|at /);
    const failure = lines.find(line => line['msg'] === 'Request failed');
    expect(failure).toMatchObject({ level: 50, error: { message: 'upstream 10.0.0.5 said: secret detail' } });
    expect((failure!['error'] as { stack: string }).stack).toContain('server.test.ts');
  });

  it('answers an error that carries its own statusCode with an opaque 500', async () => {
    const { app } = buildServer();
    app.get('/teapot', async () => {
      throw Object.assign(new Error('not ours to trust'), { statusCode: 418, code: 'ECONNRESET' });
    });

    const response = await app.inject({ method: 'GET', url: '/teapot' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  it('answers an unknown route with 404 not_found', async () => {
    const { app } = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/nothing-here' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('answers malformed JSON with 400 invalid_request, without quoting the body', async () => {
    const { app } = buildServer();
    app.post('/items', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'POST',
      url: '/items',
      headers: { 'content-type': 'application/json' },
      payload: '{"secret": body-secret',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_request', message: 'The request body is not valid JSON' } });
  });

  it('answers a body over the limit with 413 request_too_large', async () => {
    const { app } = buildServer({ bodyLimit: 16 });
    app.post('/items', async () => ({ ok: true }));

    const response = await app.inject({ method: 'POST', url: '/items', payload: { note: 'x'.repeat(32) } });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'request_too_large' } });
  });

  it('answers an unsupported content type with 415 unsupported_media_type', async () => {
    const { app } = buildServer();
    app.post('/items', async () => ({ ok: true }));

    const response = await app.inject({ method: 'POST', url: '/items', headers: { 'content-type': 'application/xml' }, payload: '<a/>' });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: { code: 'unsupported_media_type' } });
  });

  it('answers a schema violation with 400 invalid_request and the reason', async () => {
    const { app } = buildServer();
    app.post('/items', {
      schema: { body: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } },
    }, async () => ({ ok: true }));

    const response = await app.inject({ method: 'POST', url: '/items', payload: { count: 'many' } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_request', message: 'body/count must be integer' } });
  });
});

describe('HEAD (PX-8)', () => {
  it('has no automatic HEAD route, so HEAD on a GET route is 404', async () => {
    const { app } = buildServer();
    app.get('/paid', async () => ({ content: 'paid' }));

    const head = await app.inject({ method: 'HEAD', url: '/paid' });
    const getResponse = await app.inject({ method: 'GET', url: '/paid' });

    expect(head.statusCode).toBe(404);
    expect(getResponse.statusCode).toBe(200);
  });
});

describe('metrics listener (XC-2)', () => {
  it('serves request count, latency, and the default metrics on its own port, not on the public one', async () => {
    const server = buildServer();
    server.app.get('/items/:id', async () => ({ ok: true }));
    const { port, metricsPort } = await listen(server);
    expect(metricsPort).not.toBe(port);

    await get(port, '/items/1');
    await get(port, '/items/2');
    await get(port, '/missing');
    const metrics = await get(metricsPort, '/metrics');
    const onPublicPort = await get(port, '/metrics');

    expect(metrics.status).toBe(200);
    expect(metrics.body).toContain('# TYPE http_requests_total counter');
    expect(metrics.body).toContain('http_requests_total{method="GET",route="/items/:id",status="200"} 2');
    expect(metrics.body).toContain('http_requests_total{method="GET",route="unmatched",status="404"} 1');
    expect(metrics.body).toContain('# TYPE http_request_duration_seconds histogram');
    expect(metrics.body).toMatch(/http_request_duration_seconds_count\{method="GET",route="\/items\/:id",status="200"\} 2/);
    expect(metrics.body).toContain('process_cpu_user_seconds_total');
    expect(metrics.body).toContain('nodejs_eventloop_lag_seconds');
    expect(onPublicPort.status).toBe(404);
  });

  it('serves health and readiness too, for an app without a public listener (XC-3)', async () => {
    const metrics = createMetricsServer({ logger: silentLogger, health: true, readinessChecks: [{ name: 'postgres', check: async () => undefined }] });
    try {
      expect((await metrics.app.inject({ method: 'GET', url: '/_/health' })).statusCode).toBe(200);
      expect((await metrics.app.inject({ method: 'GET', url: '/_/ready' })).json()).toEqual({ status: 'ready', checks: { postgres: 'ok' } });
      expect((await metrics.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
    }
    finally {
      await metrics.close();
    }
  });

  it('serves no health routes on the metrics listener of an app with a public one', async () => {
    const { metrics } = buildServer();

    expect((await metrics.app.inject({ method: 'GET', url: '/_/health' })).statusCode).toBe(404);
  });
});

describe('listen', () => {
  it('fails and leaves neither listener open when a port is taken', async () => {
    const blocker = createNetServer();
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const takenPort = (blocker.address() as AddressInfo).port;
    const server = buildServer();
    try {
      await expect(server.listen({ host: '127.0.0.1', port: 0, metricsPort: takenPort })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(server.app.server.listening).toBe(false);
    }
    finally {
      await new Promise(resolve => blocker.close(resolve));
    }
  });
});

describe('graceful shutdown (CK-6, PX-18)', () => {
  it('stops accepting, lets an in-flight request finish, then exits with 0', async () => {
    const server = buildServer();
    let release: () => void = () => undefined;
    const entered = vi.fn();
    server.app.get('/slow', async () => {
      entered();
      await new Promise<void>(resolve => {
        release = resolve;
      });

      return { finished: true };
    });
    const { port, metricsPort } = await listen(server);
    const exit = vi.fn();
    const shutdown = createShutdownHandler({ dispose: () => server.close(), logger: silentLogger, exit });

    const inFlight = get(port, '/slow');
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    const stopping = shutdown('SIGTERM');

    // New connections are refused while the in-flight request is still running
    await vi.waitFor(async () => {
      await expect(get(port, '/_/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });
    expect(exit).not.toHaveBeenCalled();

    release();
    expect(await inFlight).toEqual({ status: 200, body: '{"finished":true}' });
    await stopping;
    expect(exit).toHaveBeenCalledWith(0);
    await expect(get(metricsPort, '/metrics')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
