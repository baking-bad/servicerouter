import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger, runApp } from '@servicerouter/common';
import { loadPlatformConfig } from '@servicerouter/core';
import { cardanoAnswers, createTestDatabase, startFakeFacilitator, type TestDatabase } from '@servicerouter/testing';

import { createApp, type WorkersServer } from '../../src/app.js';
import { startWorkers } from '../../src/start.js';

const exampleConfig = { CONFIG_PATH: 'config/example.yaml' };

let database: TestDatabase;
let server: WorkersServer;
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

describe('the hold expiry job (LG-9, WK-1, WK-4)', () => {
  it('runs under its advisory lock, and exports its last success time and duration on the metrics port', async () => {
    const result = await server.scheduler.runNow('hold_expiry');

    const text = await (await fetch(`${url}/metrics`)).text();
    expect(result).toBe('success');
    expect(text).toMatch(/^workers_job_last_success_timestamp_seconds\{job="hold_expiry"\} \d+/m);
    expect(text).toMatch(/^workers_job_duration_seconds\{job="hold_expiry"\} [\d.e-]+$/m);
    expect(text).toContain('workers_job_runs_total{job="hold_expiry",result="success"} 1');
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

describe('the facilitators at startup (PR-6, step 6)', () => {
  // Only the Cardano facilitator, at a fake: the settlement follow-up repeats settles through it (WK-6)
  const envFor = (url: string) => ({
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: Buffer.from(JSON.stringify({
      facilitators: [
        { name: 'cdp', url: 'https://api.cdp.coinbase.com/platform/v2/x402', networks: ['eip155:84532', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'], enabled: false },
        { name: 'cardano', url, networks: ['cardano:preprod'] },
      ],
    })).toString('base64'),
    DATABASE_URL: database.url.expose(),
    HOST: '127.0.0.1',
    METRICS_PORT: '0',
  });

  it('starts once every enabled facilitator answers /supported with exact on its networks', async () => {
    const facilitator = await startFakeFacilitator({ networks: ['cardano:preprod'] });
    try {
      const app = await startWorkers({ env: envFor(facilitator.url), logger: createLogger({ level: 'silent' }) });
      await app.close();

      expect(facilitator.requests.map(request => request.path)).toContain('/supported');
    }
    finally {
      await facilitator.close();
    }
  });

  it.each([
    ['its /supported fails', (facilitator: Awaited<ReturnType<typeof startFakeFacilitator>>) => facilitator.handle('/supported', cardanoAnswers.backendDown()), 'The cardano facilitator\'s /supported failed'],
    ['it doesn\'t list exact on its network', () => undefined, 'doesn\'t list exact on cardano:preprod'],
  ])('exits with 1 and names the facilitator when %s', async (_case, script, message) => {
    // Supports mainnet only, unless the case scripts /supported
    const facilitator = await startFakeFacilitator({ networks: ['cardano:mainnet'] });
    script(facilitator);
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const exit = vi.fn();
    try {
      await runApp({ name: 'workers', start: startWorkers, logger, exit, env: envFor(facilitator.url) });

      expect(exit).toHaveBeenCalledWith(1);
      expect(JSON.stringify(lines.find(line => line['msg'] === 'Failed to start'))).toContain(message);
    }
    finally {
      await facilitator.close();
    }
  });
});
