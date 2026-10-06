import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger, runApp, type MetricsServer } from '@servicerouter/common';
import { loadPlatformConfig } from '@servicerouter/core';
import { createTestDatabase, type TestDatabase } from '@servicerouter/testing';

import { createApp } from '../../src/app.js';
import { startWorkers } from '../../src/start.js';

const exampleConfig = { CONFIG_PATH: 'config/example.yaml' };

let database: TestDatabase;
let server: MetricsServer;
let url: string;

beforeAll(async () => {
  const config = await loadPlatformConfig({ env: exampleConfig });
  database = await createTestDatabase();
  server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres });
  const port = await server.listen({ host: '127.0.0.1', port: 0 });
  url = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server?.close();
  await database?.drop();
});

describe('workers on the metrics port (XC-2, XC-3)', () => {
  it('answers /_/health, /_/ready with the Postgres check, and /metrics on one port', async () => {
    const [health, ready, metrics] = await Promise.all([
      fetch(`${url}/_/health`),
      fetch(`${url}/_/ready`),
      fetch(`${url}/metrics`),
    ]);

    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready', checks: { postgres: 'ok' } });
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('process_cpu_user_seconds_total');
  });
});

describe('startup (PC-1)', () => {
  it('exits with 1 and logs the reason when the platform config is invalid', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const exit = vi.fn();

    await runApp({ name: 'workers', start: startWorkers, logger, exit, env: { CONFIG_PATH: 'config/missing.yaml' } });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({
      level: 60,
      error: { message: expect.stringContaining('config/missing.yaml') },
    });
  });
});
