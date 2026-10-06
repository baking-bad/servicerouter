import { fixtureDay, fixtureTime } from '@servicerouter/testing';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret } from '@servicerouter/common';
import { loadPlatformConfig, type HoldInput, type PlatformConfig } from '@servicerouter/core';
import {
  auditLog, createKeyStore, createLedger, createPaymentKeyRepository, createPaymentRepository, createServiceRepository, type Ledger,
} from '@servicerouter/db';
import type { CreditsLedger, KeyStore, PaymentRecorder } from '@servicerouter/payments';
import {
  createFakeClock, createTestDatabase, createTestRedis, createTestSecretKeys, type FakeClock, type TestDatabase, type TestRedis,
} from '@servicerouter/testing';

import { createApp, type ApiServer } from '../../src/app.js';

const internalSecret = 'internal-secret-0123456789abcdef-xyz';

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let clock: FakeClock;
let server: ApiServer;
let ledger: Ledger;
let url: string;
let internalUrl: string;
let counter = 0;

beforeAll(async () => {
  let keys;
  [database, redis, config, keys] = await Promise.all([
    createTestDatabase(),
    createTestRedis(),
    loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from('rateLimits:\n  signup: { requests: 1000, windowSeconds: 60 }\n').toString('base64') } }),
    createTestSecretKeys(),
  ]);
  clock = createFakeClock(fixtureTime(0, 5, 12, 0, 0, 0));
  server = createApp({
    config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock, sealer: keys.sealer, internalSecret: Secret.from(internalSecret),
  });
  const { port, internalPort } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 });
  url = `http://127.0.0.1:${port}`;
  internalUrl = `http://127.0.0.1:${internalPort!}`;
  ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
});

afterAll(async () => {
  await server?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const signup = async (): Promise<{ readonly id: string; readonly masterKey: string }> =>
  await (await fetch(`${url}/v1/accounts`, { method: 'POST' })).json() as { id: string; masterKey: string };

const get = async (masterKey: string, path: string) => {
  const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${masterKey}` } });

  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const credit = async (base: string, accountId: string, body: unknown, headers: Record<string, string> = { 'x-internal-secret': internalSecret }) => {
  const response = await fetch(`${base}/internal/v1/accounts/${accountId}/credits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> };
};

const nextReference = () => {
  counter += 1;

  return `ticket-${counter}`;
};

const paymentKey = async (accountId: string): Promise<string> => {
  counter += 1;
  const id = `key_ledger_${counter}`;
  await createPaymentKeyRepository({ db: database.db }).insert({
    id, accountId, keyHash: counter.toString(16).padStart(64, 'f'), label: undefined, createdAt: clock.now(),
    allowance: undefined, dailyBudget: 5_000_000n, maxPrice: undefined, expiresAt: undefined,
  });

  return id;
};

const hold = async (accountId: string, keyId: string, amount: bigint, changes: Partial<HoldInput['payment']> = {}): Promise<string> => {
  counter += 1;
  const result = await ledger.hold({
    payment: {
      id: `pay_ledger_${counter}`, requestId: undefined, kind: 'service', rail: 'credits', buyerAccountId: accountId, keyId,
      sellerAccountId: undefined, serviceId: undefined, routeKey: undefined, targetHost: undefined, targetPath: undefined,
      network: undefined, asset: undefined, atomicAmount: undefined, amount, ...changes,
    },
    dailyBudget: 5_000_000n,
    allowance: undefined,
  });
  if (!result.ok)
    throw new Error(result.refusal);

  return result.payment.id;
};

describe('the internal API (PA-4)', () => {
  it('credits an account once per reference, writes the audit log for every call, and answers a replay with the first credit', async () => {
    const owner = await signup();
    const reference = nextReference();

    const first = await credit(internalUrl, owner.id, { amount: '10.00', reference }, { 'x-internal-secret': internalSecret, 'x-internal-caller': 'operator', 'x-request-id': `credit-${reference}` });
    const replay = await credit(internalUrl, owner.id, { amount: '10.00', reference });

    expect(first).toMatchObject({ status: 201, body: { accountId: owner.id, amount: '10', reference, replayed: false } });
    expect(replay).toMatchObject({ status: 200, body: { transactionId: first.body['transactionId'], replayed: true } });
    expect((await get(owner.masterKey, '/v1/balance')).body).toEqual({ available: '10', held: '0' });
    const entries = await database.db.select().from(auditLog).where(and(eq(auditLog.subjectId, owner.id), eq(auditLog.action, 'ledger.credit')));
    expect(entries).toEqual([
      expect.objectContaining({ actorKind: 'internal_api', actorId: 'operator', requestId: `credit-${reference}`, details: expect.objectContaining({ amount: '10000000', reference, replayed: false }) }),
      expect.objectContaining({ actorKind: 'internal_api', actorId: 'unknown', details: expect.objectContaining({ replayed: true }) }),
    ]);
  });

  it('answers a reference reused for another amount with 409 idempotency_conflict, and moves nothing', async () => {
    const owner = await signup();
    const reference = nextReference();
    await credit(internalUrl, owner.id, { amount: '1', reference });

    const conflict = await credit(internalUrl, owner.id, { amount: '2', reference });

    expect(conflict).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } });
    expect((await get(owner.masterKey, '/v1/balance')).body).toEqual({ available: '1', held: '0' });
  });

  it.each([
    ['without the shared secret', {}],
    ['with the wrong shared secret', { 'x-internal-secret': `${internalSecret}-wrong` }],
    ['with a secret that only shares its start', { 'x-internal-secret': internalSecret.slice(0, 10) }],
  ])('answers a call %s with 401 unauthorized, and moves nothing', async (_case, headers) => {
    const owner = await signup();

    const response = await credit(internalUrl, owner.id, { amount: '1', reference: nextReference() }, headers);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(response.body).toEqual({ error: { code: 'unauthorized', message: 'The internal API needs the x-internal-secret header' } });
    expect((await get(owner.masterKey, '/v1/balance')).body).toEqual({ available: '0', held: '0' });
  });

  it('never answers on the public port, even with the shared secret', async () => {
    const owner = await signup();

    const response = await credit(url, owner.id, { amount: '1', reference: nextReference() });

    expect(response).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    expect((await get(owner.masterKey, '/v1/balance')).body).toEqual({ available: '0', held: '0' });
  });

  it.each([
    ['an unknown account', 'acc_unknown', { amount: '1', reference: 'r-1' }, 404, 'not_found'],
    ['a zero amount', undefined, { amount: '0', reference: 'r-2' }, 400, 'invalid_request'],
    ['an amount with 7 decimals', undefined, { amount: '0.0000001', reference: 'r-3' }, 400, 'invalid_request'],
    ['a reference with a space', undefined, { amount: '1', reference: 'a b' }, 400, 'invalid_request'],
  ])('answers %s with %i', async (_case, accountId, body, status, code) => {
    const owner = await signup();

    const response = await credit(internalUrl, accountId ?? owner.id, body);

    expect(response).toMatchObject({ status, body: { error: { code } } });
  });

  it('refuses every call when the API has no shared secret configured', async () => {
    const bare = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock, sealer: (await createTestSecretKeys()).sealer });
    const { internalPort } = await bare.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 });
    try {
      const owner = await signup();

      const response = await credit(`http://127.0.0.1:${internalPort!}`, owner.id, { amount: '1', reference: nextReference() }, { 'x-internal-secret': '' });

      expect(response.status).toBe(401);
    }
    finally {
      await bare.close();
    }
  });
});

describe('GET /v1/balance and GET /v1/payments', () => {
  it('shows the balance after an admin credit, and after a hold (step 4)', async () => {
    const owner = await signup();
    await credit(internalUrl, owner.id, { amount: '2.5', reference: nextReference() });
    const keyId = await paymentKey(owner.id);

    await hold(owner.id, keyId, 500_000n);

    expect((await get(owner.masterKey, '/v1/balance')).body).toEqual({ available: '2', held: '0.5' });
  });

  it('pages the caller\'s payments as a buyer, newest first, and never shows another buyer\'s', async () => {
    const [owner, other] = [await signup(), await signup()];
    await credit(internalUrl, owner.id, { amount: '1', reference: nextReference() });
    await credit(internalUrl, other.id, { amount: '1', reference: nextReference() });
    const [keyId, otherKey] = [await paymentKey(owner.id), await paymentKey(other.id)];
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      clock.advance(1_000);
      ids.push(await hold(owner.id, keyId, 1_000n));
    }
    await hold(other.id, otherKey, 1_000n);

    const first = await get(owner.masterKey, '/v1/payments?limit=2');
    const second = await get(owner.masterKey, `/v1/payments?limit=2&after=${first.body['next'] as string}`);

    expect((first.body['payments'] as { id: string }[]).map(item => item.id)).toEqual([ids[2], ids[1]]);
    expect(second.body).toEqual({ payments: [expect.objectContaining({ id: ids[0], amount: '0.001', status: 'held', rail: 'credits' })], next: null });
  });
});

describe('GET /v1/services/{id}/earnings (LG-10)', () => {
  it('shows the owner a captured call: calls, USD earned by rail, the fee, paid out, pending, and the next payout date', async () => {
    const [seller, buyer] = [await signup(), await signup()];
    const serviceId = `svc-earnings-${seller.id.slice(-8)}`;
    await createServiceRepository({ db: database.db }).createIfMissing({ id: serviceId as never, ownerAccountId: seller.id, state: 'live', createdAt: clock.now() });
    await credit(internalUrl, buyer.id, { amount: '1', reference: nextReference() });
    const paymentId = await hold(buyer.id, await paymentKey(buyer.id), 1_000n, { sellerAccountId: seller.id, serviceId, routeKey: 'getWeather' });

    await ledger.capture({ paymentId, feeBps: 250 });
    const earnings = await get(seller.masterKey, `/v1/services/${serviceId}/earnings`);

    expect(earnings).toEqual({
      status: 200,
      body: {
        serviceId,
        calls: 1,
        earned: { total: '0.000975', byRail: { credits: '0.000975' } },
        fee: '0.000025',
        paidOut: '0',
        pending: '0.000975',
        nextPayoutDate: fixtureDay(1, 1),
      },
    });
  });

  it('answers another account with 403 forbidden, and an unknown service with 404', async () => {
    const [seller, other] = [await signup(), await signup()];
    const serviceId = `svc-private-${seller.id.slice(-8)}`;
    await createServiceRepository({ db: database.db }).createIfMissing({ id: serviceId as never, ownerAccountId: seller.id, state: 'live', createdAt: clock.now() });

    expect(await get(other.masterKey, `/v1/services/${serviceId}/earnings`)).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    expect(await get(seller.masterKey, '/v1/services/no-such-service/earnings')).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
  });
});

describe('the db adapters fit the rails\' ports (PR-11, PR-10)', () => {
  it('serves CreditsLedger, PaymentRecorder, and KeyStore from db, with nothing from Fastify or Drizzle in the ports', async () => {
    const creditsLedger: CreditsLedger = ledger;
    const recorder: PaymentRecorder = createPaymentRepository({ db: database.db, clock });
    const keyStore: KeyStore = createKeyStore({ db: database.db });
    const owner = await signup();
    await credit(internalUrl, owner.id, { amount: '1', reference: nextReference() });
    const paymentId = await hold(owner.id, await paymentKey(owner.id), 10n);

    await recorder.recordDecision({ paymentId, decision: 'not_billable', upstreamStatus: 500, upstreamLatencyMs: 3 });
    const released = await creditsLedger.release({ paymentId });

    expect(released.payment).toMatchObject({ status: 'released', decision: 'not_billable' });
    expect(await keyStore.findByHash('0'.repeat(64))).toBeUndefined();
  });
});
