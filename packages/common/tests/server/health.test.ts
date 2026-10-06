import { afterEach, describe, expect, it } from 'vitest';

import { createLogger, createServer, type ReadinessCheck, type Server } from '../../src/index.js';
import { captureLogs } from './helpers.js';

const servers: Server[] = [];

const buildServer = (readinessChecks: readonly ReadinessCheck[], logger = createLogger({ level: 'silent' })): Server => {
  const server = createServer({ logger, readinessChecks });
  servers.push(server);

  return server;
};

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(done => {
    resolve = done;
  });

  return { promise, resolve };
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
});

describe('health and readiness (XC-3)', () => {
  it('answers /_/health with 200 while the process runs, whatever the checks say', async () => {
    const { app } = buildServer([{ name: 'redis', check: async () => {
      throw new Error('down');
    } }]);

    const response = await app.inject({ method: 'GET', url: '/_/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('answers /_/ready with 200 and each check\'s status when every check passes', async () => {
    const { app } = buildServer([
      { name: 'postgres', check: async () => undefined },
      { name: 'redis', check: async () => undefined },
    ]);

    const response = await app.inject({ method: 'GET', url: '/_/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it('answers /_/ready with 503 when a check fails, naming the check but not the reason', async () => {
    const { logger, lines } = captureLogs();
    const { app } = buildServer([
      { name: 'postgres', check: async () => undefined },
      { name: 'redis', check: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.7:6379');
      } },
    ], logger);

    const response = await app.inject({ method: 'GET', url: '/_/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', checks: { postgres: 'ok', redis: 'failed' } });
    expect(response.body).not.toContain('ECONNREFUSED');
    expect(lines.find(line => line['msg'] === 'Readiness check failed')).toMatchObject({
      level: 40,
      check: 'redis',
      error: { message: 'connect ECONNREFUSED 10.0.0.7:6379' },
    });
  });

  it('runs the checks concurrently', async () => {
    // Each check waits until the other has started, so checks run one after another would both time out
    const postgresStarted = deferred();
    const redisStarted = deferred();
    const { app } = buildServer([
      { name: 'postgres', check: async () => {
        postgresStarted.resolve();
        await redisStarted.promise;
      } },
      { name: 'redis', check: async () => {
        redisStarted.resolve();
        await postgresStarted.promise;
      } },
    ]);

    const response = await app.inject({ method: 'GET', url: '/_/ready' });

    expect(response.json()).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it('fails a check that hangs after its 2 s deadline, and aborts its signal (CK-7)', async () => {
    let signal: AbortSignal | undefined;
    const { app } = buildServer([
      { name: 'postgres', check: async () => undefined },
      { name: 'redis', check: received => {
        signal = received;

        return new Promise<void>(() => undefined);
      } },
    ]);

    const startedAt = performance.now();
    const response = await app.inject({ method: 'GET', url: '/_/ready' });
    const elapsedMs = performance.now() - startedAt;

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', checks: { postgres: 'ok', redis: 'failed' } });
    expect(elapsedMs).toBeGreaterThanOrEqual(1_950);
    expect(elapsedMs).toBeLessThan(3_000);
    expect(signal?.aborted).toBe(true);
  });

  it('is ready with no checks', async () => {
    const { app } = buildServer([]);

    const response = await app.inject({ method: 'GET', url: '/_/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', checks: {} });
  });
});
