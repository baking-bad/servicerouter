import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger, runApp, Secret, type Logger, type Server } from '@servicerouter/common';
import { loadPlatformConfig, type PlatformConfig } from '@servicerouter/core';
import { createPostgres, createRedis, type Postgres, type Redis } from '@servicerouter/db';
import {
  createTestDatabase, createTestRedis, createTestSecretKeys, type TestDatabase, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createApp } from '../../src/app.js';
import { startProxy } from '../../src/start.js';

const exampleConfig = { CONFIG_PATH: 'config/example.yaml' };
const silentLogger = createLogger({ level: 'silent' });

interface RunningServer {
  readonly server: Server;
  readonly url: string;
  readonly metricsUrl: string;
}

let config: PlatformConfig;
let database: TestDatabase;
let redis: TestRedis;
let keys: TestSecretKeys;
const started: Server[] = [];

const start = async (dependencies: { postgres?: Postgres; redis?: Redis; logger?: Logger } = {}): Promise<RunningServer> => {
  const server = createApp({
    config,
    logger: dependencies.logger ?? silentLogger,
    postgres: dependencies.postgres ?? database.postgres,
    redis: dependencies.redis ?? redis,
    opener: keys.opener,
  });
  server.app.get('/test/boom', async () => {
    throw new Error('upstream 10.0.0.5 said: secret detail');
  });
  server.app.post('/test/echo', async request => request.body);
  started.push(server);
  const { port, metricsPort } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

  return { server, url: `http://127.0.0.1:${port}`, metricsUrl: `http://127.0.0.1:${metricsPort}` };
};

// Accepts connections and never answers, like a dependency behind a dead network path
const startBlackhole = async () => {
  const sockets = new Set<Socket>();
  const server = createNetServer(socket => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      sockets.forEach(socket => socket.destroy());
      await new Promise(resolve => server.close(resolve));
    },
  };
};

const timed = async <TResult>(work: () => Promise<TResult>) => {
  const startedAt = performance.now();
  const result = await work();

  return { result, elapsedMs: performance.now() - startedAt };
};

const captureLogs = () => {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

  return { logger, lines };
};

beforeAll(async () => {
  config = await loadPlatformConfig({ env: exampleConfig });
  [database, redis, keys] = await Promise.all([createTestDatabase(), createTestRedis(), createTestSecretKeys()]);
});

afterEach(async () => {
  await Promise.all(started.splice(0).map(server => server.close()));
});

afterAll(async () => {
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

describe('health and readiness (XC-3, PX-17)', () => {
  it('answers /_/health with 200', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/_/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('answers /_/ready with 200 when Postgres and Redis are up', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/_/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it.each([
    ['refuses connections', 'refused'],
    ['accepts connections but never answers', 'silent'],
  ] as const)('answers /_/ready with 503 within 3 s when Redis %s', async (_case, mode) => {
    const blackhole = await startBlackhole();
    const port = mode === 'silent' ? blackhole.port : await blackhole.close().then(() => blackhole.port);
    const unreachable = createRedis({ url: Secret.from(`redis://127.0.0.1:${port}`), logger: silentLogger });
    try {
      const { url } = await start({ redis: unreachable });

      const { result: response, elapsedMs } = await timed(() => fetch(`${url}/_/ready`));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'not_ready', checks: { postgres: 'ok', redis: 'failed' } });
      expect(elapsedMs).toBeLessThan(3_000);
    }
    finally {
      await unreachable.close();
      await blackhole.close();
    }
  });

  it('answers /_/ready with 503 within 3 s when Postgres hangs (CK-7)', async () => {
    const blackhole = await startBlackhole();
    const hanging = createPostgres({ url: Secret.from(`postgres://user:password@127.0.0.1:${blackhole.port}/db`), logger: silentLogger });
    try {
      const { url } = await start({ postgres: hanging });

      const { result: response, elapsedMs } = await timed(() => fetch(`${url}/_/ready`));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'not_ready', checks: { postgres: 'failed', redis: 'ok' } });
      expect(elapsedMs).toBeGreaterThanOrEqual(1_950);
      expect(elapsedMs).toBeLessThan(3_000);
    }
    finally {
      await blackhole.close();
      await hanging.close();
    }
  });
});

describe('request ID (XC-5)', () => {
  it('returns an incoming x-request-id and puts it on the request\'s log lines', async () => {
    const { logger, lines } = captureLogs();
    const { url } = await start({ logger });

    const response = await fetch(`${url}/_/ready`, { headers: { 'x-request-id': 'abc-123' } });

    expect(response.headers.get('x-request-id')).toBe('abc-123');
    await vi.waitFor(() => expect(lines.filter(line => line['requestId'] === 'abc-123')).toEqual([
      expect.objectContaining({ msg: 'Request completed', method: 'GET', route: '/_/ready', status: 200 }),
    ]));
  });

  it('generates an ID for a request without one', async () => {
    const { logger, lines } = captureLogs();
    const { url } = await start({ logger });

    const response = await fetch(`${url}/_/health`);

    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await vi.waitFor(() => expect(lines).toContainEqual(expect.objectContaining({ requestId, msg: 'Request completed' })));
  });
});

describe('errors (PA-3, XC-7)', () => {
  it('answers an unknown route with 404 not_found in the error envelope', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/_/nothing-here`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('answers a thrown plain Error with an opaque 500 internal_error, with no stack or message', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/test/boom`);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
    expect(body).not.toMatch(/secret detail|10\.0\.0\.5|app\.test\.ts/);
  });

});

describe('limits (PX-8)', () => {
  it('answers HEAD on a GET route with 404, so a paid GET can\'t be reached for free', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/_/health`, { method: 'HEAD' });

    expect(response.status).toBe(404);
  });

  it('takes request bodies up to the platform config limit, and answers 413 above it', async () => {
    const { server } = await start();
    const limit = config.sizeLimits.requestBodyBytes;
    // Injected: over a socket, the server answers 413 and closes while a 1 MiB upload is still being
    // written, and the client can see a reset instead of the answer
    const post = (bytes: number) => server.app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'text/plain' },
      payload: 'x'.repeat(bytes),
    });

    const atLimit = await post(limit);
    const overLimit = await post(limit + 1);

    expect(limit).toBe(1_048_576);
    expect(atLimit.statusCode).toBe(200);
    expect(overLimit.statusCode).toBe(413);
    expect(overLimit.json()).toMatchObject({ error: { code: 'request_too_large' } });
  });
});

describe('metrics (XC-2, PX-17)', () => {
  it('lists the request counter and the latency histogram on the metrics port', async () => {
    const { url, metricsUrl } = await start();
    await fetch(`${url}/_/health`);

    const response = await fetch(`${metricsUrl}/metrics`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(body).toContain('http_requests_total{method="GET",route="/_/health",status="200"} 1');
    expect(body).toContain('# TYPE http_request_duration_seconds histogram');
    expect(body).toContain('http_request_duration_seconds_count{method="GET",route="/_/health",status="200"} 1');
  });
});

describe('startup (PC-1)', () => {
  it('exits with 1 and logs the reason when the platform config is invalid', async () => {
    const { logger, lines } = captureLogs();
    const exit = vi.fn();
    // Equal key prefixes, which PC-7 forbids
    const override = Buffer.from('keyPrefixes:\n  master: sr_test_\n').toString('base64');

    await runApp({ name: 'proxy', start: startProxy, logger, exit, env: { ...exampleConfig, CONFIG: override } });

    expect(exit).toHaveBeenCalledWith(1);
    const failure = lines.find(line => line['msg'] === 'Failed to start');
    expect(failure).toMatchObject({ level: 60 });
    expect((failure!['error'] as { message: string }).message).toContain('/keyPrefixes');
  });

  it('exits with 1 and names the missing secret when DATABASE_URL is unset', async () => {
    const { logger, lines } = captureLogs();
    const exit = vi.fn();

    await runApp({ name: 'proxy', start: startProxy, logger, exit, env: { ...exampleConfig, REDIS_URL: redis.url.expose() } });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({
      error: { message: 'Secret DATABASE_URL is not set' },
    });
  });
});

describe('the secrets private keys (SC-4, S2-D4)', () => {
  const connections = () => ({ DATABASE_URL: database.url.expose(), REDIS_URL: redis.url.expose() });
  const listen = { HOST: '127.0.0.1', PORT: '0', METRICS_PORT: '0' };
  const oneLine = (pem: string) => pem.trim().replaceAll('\n', '\\n');
  const hint = 'Generate a pair with node scripts/secrets-keygen.mjs';

  it('starts with the PEM keys on one line, each newline written as \\n', async () => {
    const app = await startProxy({ env: { ...exampleConfig, ...connections(), ...listen, SECRETS_PRIVATE_KEYS: oneLine(keys.privateKey) }, logger: silentLogger });

    await app.close();
  });

  it.each([
    ['unset', undefined, `SECRETS_PRIVATE_KEYS is not set. It holds the PEM private keys that open seller secrets. ${hint}`],
    ['not a PEM key', 'not a key', `SECRETS_PRIVATE_KEYS holds no PEM key. ${hint}`],
    ['the public key', 'PUBLIC', `SECRETS_PRIVATE_KEYS can't open secrets: The private key is not a valid, unencrypted PEM private key. ${hint}`],
  ])('exits with 1 and says why when the keys are %s, quoting no key', async (_case, value, message) => {
    const { logger, lines } = captureLogs();
    const exit = vi.fn();
    const keysValue = value === 'PUBLIC' ? oneLine(keys.publicKey) : value;

    await runApp({ name: 'proxy', start: startProxy, logger, exit, env: { ...exampleConfig, ...connections(), ...listen, SECRETS_PRIVATE_KEYS: keysValue } });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({ error: { message } });
    expect(JSON.stringify(lines)).not.toContain(keys.publicKey.split('\n')[1]);
  });
});
