import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger, runApp, Secret, type Logger, type Server } from '@servicerouter/common';
import { loadPlatformConfig, type PlatformConfig } from '@servicerouter/core';
import { createPostgres, createRedis, type Postgres, type Redis } from '@servicerouter/db';
import {
  createTestDatabase, createTestDepositWallet, createTestRedis, createTestSecretKeys, type TestDatabase, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createApp } from '../../src/app.js';
import { startApi } from '../../src/start.js';

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
    sealer: keys.sealer,
  });
  server.app.get('/test/boom', async () => {
    throw new Error('upstream 10.0.0.5 said: secret detail');
  });
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

describe('health and readiness (XC-3, PA-6)', () => {
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

    const response = await fetch(`${url}/v1/nothing-here`);

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

  it('answers HEAD on a GET route with 404 (PX-8)', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/_/health`, { method: 'HEAD' });

    expect(response.status).toBe(404);
  });
});

describe('metrics (XC-2, PA-6)', () => {
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

    await runApp({ name: 'api', start: startApi, logger, exit, env: { ...exampleConfig, CONFIG: override } });

    expect(exit).toHaveBeenCalledWith(1);
    const failure = lines.find(line => line['msg'] === 'Failed to start');
    expect(failure).toMatchObject({ level: 60 });
    expect((failure!['error'] as { message: string }).message).toContain('/keyPrefixes');
  });

  it('exits with 1 and names the missing secret when DATABASE_URL is unset', async () => {
    const { logger, lines } = captureLogs();
    const exit = vi.fn();

    await runApp({ name: 'api', start: startApi, logger, exit, env: { ...exampleConfig, REDIS_URL: redis.url.expose() } });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({
      error: { message: 'Secret DATABASE_URL is not set' },
    });
  });
});

describe('the secrets public key (S2-D4, SC-2)', () => {
  const connections = () => ({ DATABASE_URL: database.url.expose(), REDIS_URL: redis.url.expose() });
  const listen = {
    HOST: '127.0.0.1', PORT: '0', METRICS_PORT: '0', INTERNAL_PORT: '0', INTERNAL_API_SECRET: 'internal-secret-0123456789abcdef-xyz',
    DEPOSIT_ACCOUNT_PUBLIC_KEY: createTestDepositWallet().accountPublicKey,
  };
  const oneLine = (pem: string) => pem.trim().replaceAll('\n', '\\n');

  it('starts with the PEM key on one line, each newline written as \\n', async () => {
    const app = await startApi({ env: { ...exampleConfig, ...connections(), ...listen, SECRETS_PUBLIC_KEY: oneLine(keys.publicKey) }, logger: silentLogger });

    await app.close();
    expect(oneLine(keys.publicKey)).not.toContain('\n');
  });

  it.each([
    ['unset', undefined, 'SECRETS_PUBLIC_KEY is not set. It holds the PEM public key that seals seller secrets. Generate a pair with node scripts/secrets-keygen.mjs'],
    ['empty', ' ', 'SECRETS_PUBLIC_KEY is not set. It holds the PEM public key that seals seller secrets. Generate a pair with node scripts/secrets-keygen.mjs'],
    ['not a key', 'not a key', 'SECRETS_PUBLIC_KEY can\'t seal secrets: The public key is not a valid PEM public key. Generate a pair with node scripts/secrets-keygen.mjs'],
  ])('exits with 1 and says why when the key is %s', async (_case, value, message) => {
    const { logger, lines } = captureLogs();
    const exit = vi.fn();

    await runApp({ name: 'api', start: startApi, logger, exit, env: { ...exampleConfig, ...connections(), ...listen, SECRETS_PUBLIC_KEY: value } });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({ error: { message } });
  });

  it('exits with 1 when handed the private key, without logging it', async () => {
    const { logger, lines } = captureLogs();
    const exit = vi.fn();

    await runApp({ name: 'api', start: startApi, logger, exit, env: { ...exampleConfig, ...connections(), ...listen, SECRETS_PUBLIC_KEY: oneLine(keys.privateKey) } });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({
      error: { message: 'SECRETS_PUBLIC_KEY can\'t seal secrets: The sealer takes the public key only, and this is a private key. Generate a pair with node scripts/secrets-keygen.mjs' },
    });
    expect(JSON.stringify(lines)).not.toContain(keys.privateKey.split('\n')[1]);
  });
});

describe('the internal API secret (PA-4)', () => {
  const env = () => ({
    ...exampleConfig,
    DATABASE_URL: database.url.expose(),
    REDIS_URL: redis.url.expose(),
    SECRETS_PUBLIC_KEY: keys.publicKey,
    DEPOSIT_ACCOUNT_PUBLIC_KEY: createTestDepositWallet().accountPublicKey,
    HOST: '127.0.0.1',
    PORT: '0',
    METRICS_PORT: '0',
    INTERNAL_PORT: '0',
  });

  it.each([
    ['unset', undefined, 'Secret INTERNAL_API_SECRET is not set'],
    ['shorter than 32 characters', 'too-short', 'INTERNAL_API_SECRET must be at least 32 characters'],
  ])('exits with 1 when it is %s, without logging it', async (_case, value, message) => {
    const { logger, lines } = captureLogs();
    const exit = vi.fn();

    await runApp({ name: 'api', start: startApi, logger, exit, env: { ...env(), INTERNAL_API_SECRET: value } });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({ error: { message } });
    if (value)
      expect(JSON.stringify(lines)).not.toContain(value);
  });
});

describe('the deposit account public key (DP-1)', () => {
  const env = () => ({
    ...exampleConfig,
    DATABASE_URL: database.url.expose(),
    REDIS_URL: redis.url.expose(),
    SECRETS_PUBLIC_KEY: keys.publicKey,
    INTERNAL_API_SECRET: 'internal-secret-0123456789abcdef-xyz',
    HOST: '127.0.0.1',
    PORT: '0',
    METRICS_PORT: '0',
    INTERNAL_PORT: '0',
  });

  it.each([
    ['unset', undefined, 'DEPOSIT_ACCOUNT_PUBLIC_KEY is required while deposits are on (deposits in platform config)'],
    ['not 128 hex characters', 'acct_xvk1notakey', 'DEPOSIT_ACCOUNT_PUBLIC_KEY: The deposit account public key must be 128 hex characters: the key, then the chain code'],
  ])('exits with 1 when it is %s while deposits are on', async (_case, value, message) => {
    const { logger, lines } = captureLogs();
    const exit = vi.fn();

    await runApp({ name: 'api', start: startApi, logger, exit, env: { ...env(), DEPOSIT_ACCOUNT_PUBLIC_KEY: value } });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({ error: { message } });
  });

  it('starts without it while deposits are off', async () => {
    const off = Buffer.from(JSON.stringify({ deposits: { asset: 'cardano-usdm', enabled: false } })).toString('base64');
    const app = await startApi({ env: { ...env(), CONFIG: off }, logger: silentLogger });

    await app.close();
  });
});

describe('CORS for the website\'s console (PA-7, WB-8)', () => {
  const website = 'https://staging.servicerouter.ai';
  const preflight = (url: string, origin: string) => fetch(`${url}/v1/keys`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
  });

  it('answers the website\'s preflight with 204, the methods and headers the console uses, cached for 10 minutes', async () => {
    const { url } = await start();

    const response = await preflight(url, website);

    expect(response.status).toBe(204);
    expect(Object.fromEntries([...response.headers].filter(([name]) => name.startsWith('access-control-') || name === 'vary'))).toEqual({
      'access-control-allow-origin': website,
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-max-age': '600',
      'access-control-expose-headers': 'x-request-id',
      vary: 'Origin',
    });
  });

  it('lets the website read every answer, errors included, and no other origin', async () => {
    const { url } = await start();

    const refused = await fetch(`${url}/v1/account`, { headers: { origin: website, authorization: 'Bearer srm_test_nope' } });
    const signup = await fetch(`${url}/v1/accounts`, { method: 'POST', headers: { origin: website } });
    const other = await fetch(`${url}/v1/account`, { headers: { origin: 'https://evil.example.com' } });
    const otherPreflight = await preflight(url, 'https://evil.example.com');

    expect(refused.status).toBe(401);
    expect(refused.headers.get('access-control-allow-origin')).toBe(website);
    expect(signup.status).toBe(201);
    expect(signup.headers.get('access-control-allow-origin')).toBe(website);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    expect(otherPreflight.status).not.toBe(204);
    expect(otherPreflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('adds the origins of CORS_ORIGINS for local development, and refuses one that isn\'t an origin', async () => {
    const { readCorsOrigins } = await import('../../src/cors.js');

    expect(readCorsOrigins({ CORS_ORIGINS: 'http://localhost:3000, http://127.0.0.1:3000' }, website)).toEqual([website, 'http://localhost:3000', 'http://127.0.0.1:3000']);
    expect(readCorsOrigins({}, `${website}/`)).toEqual([website]);
    expect(() => readCorsOrigins({ CORS_ORIGINS: 'http://localhost:3000/console' }, website)).toThrow('CORS_ORIGINS holds "http://localhost:3000/console"');
    expect(() => readCorsOrigins({ CORS_ORIGINS: 'localhost' }, website)).toThrow('CORS_ORIGINS');
  });
});
