import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createLogger, type Server } from '@servicerouter/common';
import { generateApiKey, loadPlatformConfig, type ApiKeyRepository, type PlatformConfig } from '@servicerouter/core';
import { accounts, auditLog, createApiKeyRepository } from '@servicerouter/db';
import {
  createTestDatabase, createTestRedis, createTestSecretKeys, type TestDatabase, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { lostKeyNotice } from '../../src/accounts/routes.js';
import { createApp } from '../../src/app.js';

const base64 = (yaml: string) => Buffer.from(yaml).toString('base64');
const loadConfig = (signupLimit: string) => loadPlatformConfig({
  env: { CONFIG_PATH: 'config/example.yaml', CONFIG: base64(`rateLimits:\n  signup: ${signupLimit}\n`) },
});

interface Started {
  readonly url: string;
  readonly logs: Record<string, unknown>[];
  readonly lookups: MockInstance<ApiKeyRepository['findActiveByHash']>;
}

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let keys: TestSecretKeys;
const servers: Server[] = [];

const start = async ({ config: appConfig = config, trustProxy }: { config?: PlatformConfig; trustProxy?: string } = {}): Promise<Started> => {
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger({}, { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) });
  const apiKeys = createApiKeyRepository({ db: database.db });
  const lookups = vi.spyOn(apiKeys, 'findActiveByHash');
  const server = createApp({ config: appConfig, logger, postgres: database.postgres, redis, apiKeys, trustProxy, sealer: keys.sealer });
  servers.push(server);
  const { port } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

  return { url: `http://127.0.0.1:${port}`, logs, lookups };
};

let app: Started;

const signup = async (body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${app.url}/v1/accounts`, {
    method: 'POST',
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return { response, body: await response.json() as Record<string, unknown> };
};

const withKey = (key: string) => ({ authorization: `Bearer ${key}` });

const getAccount = async (headers: Record<string, string>) => {
  const response = await fetch(`${app.url}/v1/account`, { headers });

  return { response, body: await response.json() as Record<string, unknown> };
};

const rotate = async (headers: Record<string, string>) => {
  const response = await fetch(`${app.url}/v1/account/master-key/rotate`, { method: 'POST', headers });

  return { response, body: await response.json() as Record<string, unknown> };
};

beforeAll(async () => {
  [database, redis, config, keys] = await Promise.all([
    createTestDatabase(), createTestRedis(), loadConfig('{ requests: 1000, windowSeconds: 60 }'), createTestSecretKeys(),
  ]);
  app = await start();
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

describe('POST /v1/accounts (AK-1, AK-3, PA-1)', () => {
  it('creates an account and returns its master key once, with the srm_test_ prefix and the lost-key notice', async () => {
    const { response, body } = await signup();

    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({
      id: expect.stringMatching(/^acc_/),
      email: null,
      emailConfirmed: false,
      topupUrl: null,
      createdAt: expect.any(String),
      masterKey: expect.stringMatching(/^srm_test_[0-9A-Za-z]{43}$/),
      notice: lostKeyNotice,
    });
    expect(lostKeyNotice).toContain('can\'t be recovered');
  });

  it('takes an optional email', async () => {
    const { response, body } = await signup({ email: 'owner@example.com' });

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ email: 'owner@example.com', emailConfirmed: false });
  });

  it('takes an empty JSON body, or an empty object', async () => {
    const empty = await fetch(`${app.url}/v1/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    const emptyObject = await signup({});

    expect(empty.status).toBe(201);
    expect(emptyObject.response.status).toBe(201);
  });

  it.each([
    ['an invalid email', { email: 'not-an-email' }],
    ['an email over 254 characters', { email: `${'a'.repeat(250)}@example.com` }],
    ['an email that isn\'t a string', { email: 42 }],
    ['a list', []],
  ])('refuses %s with 400 invalid_request and creates nothing', async (_case, body) => {
    const before = await database.db.$count(accounts);

    const result = await signup(body);

    expect(result.response.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'invalid_request' } });
    expect(await database.db.$count(accounts)).toBe(before);
  });

  it('writes the audit entry with the request ID (AK-16, XC-5)', async () => {
    const { body } = await signup(undefined, { 'x-request-id': 'signup-req-1' });

    const entries = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, body['id'] as string));
    expect(entries).toEqual([expect.objectContaining({ action: 'account.create', requestId: 'signup-req-1' })]);
    expect(JSON.stringify(entries)).not.toContain(body['masterKey'] as string);
  });
});

describe('GET /v1/account (AK-2, PA-2)', () => {
  it('returns the account for its master key', async () => {
    const { body: created } = await signup({ email: 'reader@example.com' });

    const { response, body } = await getAccount(withKey(created['masterKey'] as string));

    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: created['id'],
      email: 'reader@example.com',
      emailConfirmed: false,
      topupUrl: null,
      createdAt: created['createdAt'],
    });
  });
});

describe('POST /v1/account/master-key/rotate (AK-5, AK-9, AK-16)', () => {
  it('returns a new master key; the old one gets 401 invalid_key on the very next request, and the new one works', async () => {
    const { body: created } = await signup();
    const oldKey = created['masterKey'] as string;

    const rotated = await rotate({ ...withKey(oldKey), 'x-request-id': 'rotate-req-1' });
    const newKey = rotated.body['masterKey'] as string;
    const withOld = await getAccount(withKey(oldKey));
    const withNew = await getAccount(withKey(newKey));

    expect(rotated.response.status).toBe(200);
    expect(rotated.response.headers.get('cache-control')).toBe('no-store');
    expect(newKey).toMatch(/^srm_test_[0-9A-Za-z]{43}$/);
    expect(newKey).not.toBe(oldKey);
    expect(withOld.response.status).toBe(401);
    expect(withOld.body).toEqual({ error: { code: 'invalid_key', message: 'The key is invalid or revoked' } });
    expect(withNew.response.status).toBe(200);
    expect(withNew.body['id']).toBe(created['id']);
    const rotations = await database.db.select().from(auditLog).where(eq(auditLog.requestId, 'rotate-req-1'));
    expect(rotations).toEqual([expect.objectContaining({ action: 'master_key.rotate', actorId: created['id'] })]);
  });

  it('refuses a second rotation with the old key, and rotates again with the new one', async () => {
    const { body: created } = await signup();
    const oldKey = created['masterKey'] as string;
    const { body: first } = await rotate(withKey(oldKey));

    const again = await rotate(withKey(oldKey));
    const next = await rotate(withKey(first['masterKey'] as string));

    expect(again.response.status).toBe(401);
    expect(again.body).toMatchObject({ error: { code: 'invalid_key' } });
    expect(next.response.status).toBe(200);
  });
});

describe('master key auth (PA-2, PA-3, AK-4)', () => {
  const paymentKey = () => generateApiKey('payment', config.keyPrefixes).expose();

  it.each([
    ['GET /v1/account', getAccount],
    ['POST /v1/account/master-key/rotate', rotate],
  ])('answers a payment key on %s with 401 wrong_key_type, without a database lookup', async (_route, call) => {
    app.lookups.mockClear();

    const { response, body } = await call(withKey(paymentKey()));

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: { code: 'wrong_key_type', message: 'A payment key works only on the proxy. The Platform API takes the master key.' },
    });
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(app.lookups).not.toHaveBeenCalled();
  });

  it.each([
    ['a master key that is too short', 'srm_test_abc'],
    ['a master key with a character outside base62', `srm_test_${'a'.repeat(42)}-`],
    ['a key with an unknown prefix', `srm_live_${'a'.repeat(43)}`],
    ['a random token', 'not-a-key'],
  ])('answers %s with 401 invalid_key, without a database lookup', async (_case, key) => {
    app.lookups.mockClear();

    const { response, body } = await getAccount(withKey(key));

    expect(response.status).toBe(401);
    expect(body).toMatchObject({ error: { code: 'invalid_key' } });
    expect(app.lookups).not.toHaveBeenCalled();
  });

  it('answers an unknown well-formed master key with 401 invalid_key after one lookup', async () => {
    app.lookups.mockClear();

    const { response, body } = await getAccount(withKey(generateApiKey('master', config.keyPrefixes).expose()));

    expect(response.status).toBe(401);
    expect(body).toMatchObject({ error: { code: 'invalid_key' } });
    expect(app.lookups).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no Authorization header', {}],
    ['another scheme', { authorization: 'Basic c3JtX3Rlc3RfOg==' }],
    ['an empty Bearer', { authorization: 'Bearer ' }],
  ])('answers %s with 401 unauthorized', async (_case, headers) => {
    const { response, body } = await getAccount(headers);

    expect(response.status).toBe(401);
    expect(body).toMatchObject({ error: { code: 'unauthorized' } });
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('takes the scheme in any case', async () => {
    const { body: created } = await signup();

    const { response } = await getAccount({ authorization: `bearer ${created['masterKey'] as string}` });

    expect(response.status).toBe(200);
  });
});

describe('signup rate limit (PA-5)', () => {
  it('answers 429 rate_limited with Retry-After over the per-IP limit, creates nothing, and counts each IP apart', async () => {
    const limited = await start({ config: await loadConfig('{ requests: 2, windowSeconds: 60 }'), trustProxy: '127.0.0.1' });
    const post = (ip: string) => fetch(`${limited.url}/v1/accounts`, { method: 'POST', headers: { 'x-forwarded-for': ip } });
    const before = await database.db.$count(accounts);

    const statuses = [];
    for (let attempt = 0; attempt < 2; attempt += 1)
      statuses.push((await post('203.0.113.7')).status);
    const over = await post('203.0.113.7');
    const otherIp = await post('203.0.113.8');

    expect(statuses).toEqual([201, 201]);
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: { code: 'rate_limited' } });
    const retryAfter = Number(over.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(otherIp.status).toBe(201);
    expect(await database.db.$count(accounts)).toBe(before + 3);
    expect(await redis.client.get(`${redis.prefix}rl:api:signup:203.0.113.7`)).toBe('3');
  });

  it('counts an IPv6 client by its /64', async () => {
    const limited = await start({ config: await loadConfig('{ requests: 1, windowSeconds: 60 }'), trustProxy: '127.0.0.1' });
    const post = (ip: string) => fetch(`${limited.url}/v1/accounts`, { method: 'POST', headers: { 'x-forwarded-for': ip } });

    const first = await post('2001:db8:1:2::1');
    const sameSubnet = await post('2001:db8:1:2:ffff::9');

    expect(first.status).toBe(201);
    expect(sameSubnet.status).toBe(429);
    expect(await redis.client.get(`${redis.prefix}rl:api:signup:2001:db8:1:2::/64`)).toBe('2');
  });

  it('ignores X-Forwarded-For unless the peer is a trusted proxy', async () => {
    const limited = await start({ config: await loadConfig('{ requests: 1, windowSeconds: 60 }') });
    const post = (ip: string) => fetch(`${limited.url}/v1/accounts`, { method: 'POST', headers: { 'x-forwarded-for': ip } });
    await redis.client.del(`${redis.prefix}rl:api:signup:127.0.0.1`);

    const first = await post('198.51.100.1');
    const spoofed = await post('198.51.100.2');

    expect(first.status).toBe(201);
    expect(spoofed.status).toBe(429);
  });
});

describe('privacy (XC-7)', () => {
  it('never logs a key, and logs the account routes without the Authorization header', async () => {
    const { body: created } = await signup({ email: 'private@example.com' });
    const key = created['masterKey'] as string;
    const { body: rotated } = await rotate(withKey(key));
    await getAccount(withKey(rotated['masterKey'] as string));
    await getAccount(withKey(key));

    const logged = JSON.stringify(app.logs);
    for (const secret of [key, rotated['masterKey'] as string, 'private@example.com', 'Bearer'])
      expect(logged).not.toContain(secret);
    expect(app.logs).toContainEqual(expect.objectContaining({ route: '/v1/account/master-key/rotate', status: 200 }));
    expect(app.logs).toContainEqual(expect.objectContaining({ route: '/v1/account', status: 401 }));
  });
});
