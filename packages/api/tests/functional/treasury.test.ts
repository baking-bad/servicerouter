import { fixtureRun, fixtureTime } from '@servicerouter/testing';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret, type Server } from '@servicerouter/common';
import { loadPlatformConfig } from '@servicerouter/core';
import { auditLog, createLedger, createPayoutRepository, ledgerAccountIds } from '@servicerouter/db';
import { createFakeClock, createTestDatabase, createTestRedis, createTestSecretKeys, type TestDatabase, type TestRedis } from '@servicerouter/testing';

import { createApp } from '../../src/app.js';

const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const clock = createFakeClock(fixtureTime(1, 1, 0, 10, 0, 0));

let database: TestDatabase;
let redis: TestRedis;
let internalUrl: string;
const servers: Server[] = [];

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  const [config, keys] = await Promise.all([loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } }), createTestSecretKeys()]);
  const server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock, sealer: keys.sealer, internalSecret: Secret.from(internalSecret) });
  servers.push(server);
  const { internalPort } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 });
  internalUrl = `http://127.0.0.1:${internalPort!}`;
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const post = async (path: string, body?: unknown) => {
  const response = await fetch(`${internalUrl}${path}`, {
    method: 'POST',
    headers: { 'x-internal-secret': internalSecret, 'x-internal-caller': 'operator', ...body === undefined ? {} : { 'content-type': 'application/json' } },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  });

  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const actions = async (subjectId: string) => (await database.db.select().from(auditLog).where(eq(auditLog.subjectId, subjectId))).map(entry => entry.action);

describe('POST /internal/v1/payouts/{run}/approve (PO-6, PA-4)', () => {
  it('approves a run awaiting approval once, with an audit entry, and refuses any other', async () => {
    const repository = createPayoutRepository({ db: database.db, clock, ids: randomIdGenerator });
    await repository.saveRun({ id: fixtureRun(1, 1), cutoff: new Date(fixtureTime(1, 1, 0, 0, 0, 0)), status: 'awaiting_approval', asset: 'cardano-usdm', payouts: [], transactions: [] });

    const approved = await post(`/internal/v1/payouts/${fixtureRun(1, 1)}/approve`);
    const again = await post(`/internal/v1/payouts/${fixtureRun(1, 1)}/approve`);
    const unknown = await post('/internal/v1/payouts/run_1999-01-01/approve');

    expect(approved).toEqual({ status: 200, body: { id: fixtureRun(1, 1), status: 'approved', total: '0', approvedAt: expect.any(String), approvedBy: 'operator' } });
    expect(again).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } });
    expect(unknown).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    expect(await actions(fixtureRun(1, 1))).toEqual(['payout.approve']);
  });
});

describe('POST /internal/v1/treasury/transfers (TR-4, TR-6)', () => {
  const transfer = {
    reference: 'swap-1',
    from: { asset: 'base-usdc', amount: '100' },
    to: { asset: 'cardano-usdm', amount: '99.5' },
    transactions: ['0xabc', 'f00d'],
  };

  it('books a rebalancing once: the source treasury holds less, the target more, the difference is conversion cost', async () => {
    const created = await post('/internal/v1/treasury/transfers', transfer);
    const replayed = await post('/internal/v1/treasury/transfers', transfer);
    const balances = await createLedger({ db: database.db, clock, ids: randomIdGenerator })
      .balancesOf([ledgerAccountIds.treasury('base-usdc'), ledgerAccountIds.treasury('cardano-usdm'), ledgerAccountIds.conversion]);

    expect(created).toMatchObject({ status: 201, body: { reference: 'swap-1', conversionCost: '0.5', replayed: false } });
    expect(replayed).toMatchObject({ status: 200, body: { replayed: true } });
    expect(Object.fromEntries(balances)).toEqual({
      'platform:treasury:base-usdc': 100_000_000n, 'platform:treasury:cardano-usdm': -99_500_000n, 'platform:conversion': -500_000n,
    });
    expect(await actions('swap-1')).toEqual(['treasury.transfer', 'treasury.transfer']);
  });

  it('refuses a reused reference for another transfer, a gain, one asset, and an asset outside the registry', async () => {
    expect(await post('/internal/v1/treasury/transfers', { ...transfer, to: { asset: 'cardano-usdm', amount: '99' } }))
      .toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } });
    expect((await post('/internal/v1/treasury/transfers', { ...transfer, reference: 'gain', to: { asset: 'cardano-usdm', amount: '101' } })).status).toBe(400);
    expect((await post('/internal/v1/treasury/transfers', { ...transfer, reference: 'same', to: { asset: 'base-usdc', amount: '99' } })).status).toBe(400);
    expect((await post('/internal/v1/treasury/transfers', { ...transfer, reference: 'nope', to: { asset: 'doge', amount: '99' } })).status).toBe(400);
  });
});
