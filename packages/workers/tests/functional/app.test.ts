import { createServer as createNetServer, type AddressInfo } from 'node:net';

import * as PrivateKey from '@evolution-sdk/evolution/PrivateKey';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger, runApp, Secret } from '@servicerouter/common';
import { createBlockfrostClient, loadPlatformConfig } from '@servicerouter/core';
import {
  cardanoAnswers, createTestCertificate, createTestDatabase, startFakeBlockfrost, startFakeFacilitator, startFakeTempoRpc, trustTestCertificate,
  type FakeTempoRpc, type TestDatabase,
} from '@servicerouter/testing';

import { createApp, type WorkersServer } from '../../src/app.js';
import { startWorkers } from '../../src/start.js';
import { createCardanoBalanceReader, createEvmBalanceReader } from '../../src/treasury/readers.js';

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

describe('the ownership re-check job (OV-6, WK-1, WK-4)', () => {
  it('runs under its advisory lock, and exports its last success time and duration on the metrics port', async () => {
    const result = await server.scheduler.runNow('ownership_recheck');

    const text = await (await fetch(`${url}/metrics`)).text();
    expect(result).toBe('success');
    expect(text).toMatch(/^workers_job_last_success_timestamp_seconds\{job="ownership_recheck"\} \d+/m);
    expect(text).toContain('workers_job_runs_total{job="ownership_recheck",result="success"} 1');
  });
});

describe('the deposit watcher job (DP-2, WK-1, WK-4)', () => {
  it('runs under its advisory lock while deposits are on and Blockfrost is wired', async () => {
    const config = await loadPlatformConfig({ env: exampleConfig });
    const blockfrost = await startFakeBlockfrost();
    const app = createApp({
      config, logger: createLogger({ level: 'silent' }), postgres: database.postgres,
      blockfrost: createBlockfrostClient({ url: blockfrost.url, projectId: Secret.from('preprodTestProjectId'), timeoutMs: 2_000 }),
    });
    try {
      expect(await app.scheduler.runNow('deposit_watcher')).toBe('success');
      expect(() => server.scheduler.runNow('deposit_watcher')).toThrow('No job named deposit_watcher');
    }
    finally {
      await app.close();
      await blockfrost.close();
    }
  });

  it('exits with 1 when BLOCKFROST_PROJECT_ID is missing while deposits are on', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const exit = vi.fn();
    const config = Buffer.from(JSON.stringify({
      facilitators: [
        { name: 'cdp', url: 'https://api.cdp.coinbase.com/platform/v2/x402', networks: ['eip155:84532', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'], enabled: false },
        { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:preprod'], enabled: false },
      ],
      mpp: { enabled: false },
    })).toString('base64');

    await runApp({
      name: 'workers', start: startWorkers, logger, exit,
      env: { ...exampleConfig, CONFIG: config, DATABASE_URL: database.url.expose(), REDIS_URL: process.env['TEST_REDIS_URL']!, HOST: '127.0.0.1', METRICS_PORT: '0' },
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({ error: { message: 'Secret BLOCKFROST_PROJECT_ID is not set' } });
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
      // MPP's Tempo RPC at startup has its own tests (PR-9)
      mpp: { enabled: false },
    })).toString('base64'),
    DATABASE_URL: database.url.expose(),
    REDIS_URL: process.env['TEST_REDIS_URL']!,
    BLOCKFROST_PROJECT_ID: 'preprodTestProjectId',
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

describe('the Tempo RPC at startup (PR-9, WK-6)', () => {
  // The follow-up reads MPP receipts there. It must be HTTPS (PC-6): the fake serves a test certificate.
  const certificate = createTestCertificate({ hosts: ['127.0.0.1'] });
  const envFor = (mpp: Record<string, unknown>) => ({
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: Buffer.from(JSON.stringify({
      facilitators: [
        { name: 'cdp', url: 'https://api.cdp.coinbase.com/platform/v2/x402', networks: ['eip155:84532', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'], enabled: false },
        { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:preprod'], enabled: false },
      ],
      mpp,
    })).toString('base64'),
    DATABASE_URL: database.url.expose(),
    REDIS_URL: process.env['TEST_REDIS_URL']!,
    BLOCKFROST_PROJECT_ID: 'preprodTestProjectId',
    HOST: '127.0.0.1',
    METRICS_PORT: '0',
  });
  const withRpc = async (work: (rpc: FakeTempoRpc) => Promise<void>) => {
    const rpc = await startFakeTempoRpc({ tls: certificate });
    const untrust = trustTestCertificate(certificate);
    try {
      await work(rpc);
    }
    finally {
      await untrust();
      await rpc.close();
    }
  };

  it('starts once the Tempo RPC answers with mpp.network\'s chain ID', async () => {
    await withRpc(async rpc => {
      const app = await startWorkers({ env: envFor({ rpcUrl: rpc.url }), logger: createLogger({ level: 'silent' }) });
      await app.close();

      expect(rpc.calls.map(call => call.method)).toEqual(['eth_chainId']);
    });
  });

  it('exits with 1 when the Tempo RPC answers another chain ID', async () => {
    await withRpc(async rpc => {
      rpc.answerChainId(4_217);
      const lines: Record<string, unknown>[] = [];
      const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
      const exit = vi.fn();

      await runApp({ name: 'workers', start: startWorkers, logger, exit, env: envFor({ rpcUrl: rpc.url }) });

      expect(exit).toHaveBeenCalledWith(1);
      expect(JSON.stringify(lines.find(line => line['msg'] === 'Failed to start'))).toContain('The Tempo RPC answers chain ID 4217, not 42431 (mpp.network)');
    });
  });

  it('never calls the Tempo RPC with mpp.enabled: false', async () => {
    await withRpc(async rpc => {
      const app = await startWorkers({ env: envFor({ enabled: false, rpcUrl: rpc.url }), logger: createLogger({ level: 'silent' }) });
      await app.close();

      expect(rpc.calls).toEqual([]);
    });
  });
});

describe('the workers\' lines (L-1, L-8, L-9, L-11)', () => {
  const closedPort = async (): Promise<number> => {
    const listener = createNetServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const { port } = listener.address() as AddressInfo;
    await new Promise(resolve => listener.close(resolve));

    return port;
  };

  it('runs every job without logging a secret: an RPC\'s error is its short message, never its URL with a key, and Blockfrost\'s project ID stays out', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const config = await loadPlatformConfig({ env: exampleConfig });
    const blockfrost = await startFakeBlockfrost();
    const client = createBlockfrostClient({ url: blockfrost.url, projectId: Secret.from('preprodSecretProjectId0123456789'), timeoutMs: 2_000 });
    const port = await closedPort();
    const app = createApp({
      config, logger, postgres: database.postgres, blockfrost: client,
      balanceReaders: {
        cardano: createCardanoBalanceReader(client),
        // An RPC that refuses, at a URL that carries a key in its path and its query
        evm: createEvmBalanceReader({ rpcUrlFor: () => `http://127.0.0.1:${port}/v2/evm-rpc-key-secret?apikey=evm-query-secret`, timeoutMs: 2_000 }),
      },
    });
    try {
      for (const job of app.jobs)
        await app.scheduler.runNow(job);
    }
    finally {
      await app.close();
      await blockfrost.close();
    }

    expect(lines.filter(line => line['msg'] === 'A job ran').map(line => line['job'])).toEqual(expect.arrayContaining(['hold_expiry', 'settlement_follow_up', 'catalog_index']));
    expect(lines.find(line => line['msg'] === 'A job ran' && line['job'] === 'hold_expiry')).toMatchObject({ level: 20, counts: { captured: 0, released: 0, failed: 0 } });
    expect(lines.find(line => line['msg'] === 'Failed to read a treasury balance' && line['network'] === 'eip155:84532')).toMatchObject({
      level: 50, error: { message: expect.stringContaining('HTTP request failed.') },
    });
    expect(lines.find(line => line['msg'] === 'A job failed' && line['job'] === 'treasury_balances')).toMatchObject({ level: 50, error: { message: expect.stringContaining('treasury balances couldn\'t be read') } });
    const logged = JSON.stringify(lines);
    for (const secret of ['evm-rpc-key-secret', 'evm-query-secret', 'preprodSecretProjectId0123456789', 'balanceOf', 'Request body'])
      expect(logged).not.toContain(secret);
  });

  it('logs one startup line with the commit, the jobs, payouts, and the treasury readers\' networks, at LOG_LEVEL, never a secret', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const mnemonic = PrivateKey.generateMnemonic(256);
    const env = {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        facilitators: [
          { name: 'cdp', url: 'https://api.cdp.coinbase.com/platform/v2/x402', networks: ['eip155:84532', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'], enabled: false },
          { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:preprod'], enabled: false },
        ],
        mpp: { enabled: false },
      })).toString('base64'),
      DATABASE_URL: database.url.expose(),
      REDIS_URL: process.env['TEST_REDIS_URL']!,
      BLOCKFROST_PROJECT_ID: 'preprodStartupProjectId0123456789',
      PAYOUT_WALLET_MNEMONIC: mnemonic,
      EVM_RPC_URLS: 'eip155:8453=https://base.example/v2/startup-rpc-key',
      HOST: '127.0.0.1',
      METRICS_PORT: '0',
      LOG_LEVEL: 'debug',
      GIT_SHA: 'deadbee',
    };

    const app = await startWorkers({ env, logger });
    await app.close();

    expect(logger.level).toBe('debug');
    expect(lines.filter(line => line['msg'] === 'Started')).toEqual([expect.objectContaining({
      level: 30, app: 'workers', commit: 'deadbee', logLevel: 'debug', environment: 'staging',
      rails: { credits: true, x402: [], mpp: false },
      deposits: { network: 'cardano:preprod', asset: 'cardano-usdm', confirmations: 15 },
      jobs: expect.arrayContaining(['hold_expiry', 'settlement_follow_up', 'deposit_watcher', 'payouts', 'treasury_balances', 'reconciliation']),
      blockfrost: true, payouts: true, settlementFollowUp: { facilitators: [], mpp: false },
      treasuryReaders: { cardano: true, evm: expect.arrayContaining(['eip155:8453', 'eip155:84532']) },
      ports: { metricsPort: expect.any(Number) },
    })]);
    const logged = JSON.stringify(lines);
    for (const secret of [mnemonic, mnemonic.split(' ').slice(0, 3).join(' '), 'preprodStartupProjectId0123456789', 'startup-rpc-key', database.url.expose()])
      expect(logged).not.toContain(secret);
  });
});
