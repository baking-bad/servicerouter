import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp, type ApiServer } from '@servicerouter/api';
import { createAddressPolicy, createLogger, OutboundHttp } from '@servicerouter/common';
import { loadPlatformConfig, ownershipFileLimits, type PlatformConfig } from '@servicerouter/core';
import {
  createFakeOwnershipFiles, createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, startFakeUpstream,
  type FakeOwnershipFiles, type FakeUpstream, type TestDatabase, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createHttpConsoleApi, signingOutOnUnauthorized, signUp, type ConsoleApi } from '../../src/console/api';
import { loadRecentPayments, summarizeSpend, totalEarnings } from '../../src/console/spend';
import { emptyKeyForm, toKeyLimits } from '../../src/console/ui/keyForm';

// The console's client against the real Platform API (WB-8), as a browser on the website calls it: every
// request carries the website's Origin, and every answer must let that origin read it (PA-7).

const website = 'https://staging.servicerouter.ai';
const host = 'api.example.com';
const payoutAddress = 'addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5';

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let keys: TestSecretKeys;
let upstream: FakeUpstream;
let files: FakeOwnershipFiles;
let http: OutboundHttp;
let api: ApiServer;
let apiUrl: string;

// What the browser would check before handing an answer to the page
const answers: { readonly method: string; readonly path: string; readonly allowOrigin: string | null }[] = [];
const browserFetch: typeof fetch = async (input, init = {}) => {
  const response = await fetch(input, { ...init, headers: { ...init.headers as Record<string, string>, origin: website } });
  answers.push({ method: init.method ?? 'GET', path: new URL(String(input)).pathname, allowOrigin: response.headers.get('access-control-allow-origin') });

  return response;
};

const serviceYaml = (id: string, title: string, amount: string) => `servicerouter:
  version: "1"

service:
  id: ${id}
  title: ${title}
  description: Weather for the console's test.
  category: weather

payouts:
  default:
    asset: cardano-usdm
    address: ${payoutAddress}

payments:
  default:
    amount: "${amount}"

upstreams:
  - baseUrl: ${upstream.url(host, '')}
    paths:
      /weather/{city}:
        get:
          operationId: getWeather
`;

// Sellers submit configs with the API or the seller skill, not in the console
const submit = async (masterKey: string, id: string, yaml: string): Promise<number> => {
  const response = await fetch(`${apiUrl}/v1/services/${id}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/yaml' },
    body: yaml,
  });
  await response.text();

  return response.status;
};

beforeAll(async () => {
  [database, redis, keys, upstream] = await Promise.all([createTestDatabase(), createTestRedis(), createTestSecretKeys(), startFakeUpstream({ hosts: [host] })]);
  // The example platform config, with room for every signup here
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: fileURLToPath(new URL('../../../../config/example.yaml', import.meta.url)),
      CONFIG: Buffer.from(JSON.stringify({ rateLimits: { signup: { requests: 1000, windowSeconds: 60 } } })).toString('base64'),
    },
  });
  files = createFakeOwnershipFiles();
  upstream.handle((request, response) => {
    if (!files.handle(request, response))
      response.writeHead(404).end();
  });
  // The fake upstream listens on 127.0.0.1: only this test's Outbound HTTP may reach loopback
  http = new OutboundHttp({
    ownHosts: config.ownHosts,
    resolver: createFakeResolver({ [host]: '127.0.0.1' }),
    addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: upstream.ca,
    connectTimeoutMs: ownershipFileLimits.connectTimeoutMs,
  });
  api = createApp({
    config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: http, ownershipHttp: http,
    ownershipFileUrl: name => upstream.url(name, '/.well-known/servicerouter.json'),
  });
  const { port } = await api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
  apiUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await api?.close();
  await http?.close();
  await upstream?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

describe('the console against the Platform API, from the website\'s origin (WB-8, PA-7)', () => {
  it('signs up, manages payment keys, reads the balance, payments, and services, rolls back, checks ownership, and rotates the master key', async () => {
    // Sign up: the master key once, with its notice (AK-1)
    const signup = await signUp(apiUrl, browserFetch);
    expect(signup.masterKey).toMatch(/^srm_/);
    expect(signup.notice).toEqual(expect.any(String));
    const onUnauthorized = vi.fn();
    const consoleFor = (key: string): ConsoleApi => signingOutOnUnauthorized(createHttpConsoleApi({ apiUrl, key, statusMocked: false, fetch: browserFetch }), onUnauthorized);
    let client = consoleFor(signup.masterKey);

    // The account, its balance, and no payments yet
    expect(await client.account()).toMatchObject({ id: signup.id, topupUrl: null, depositAddress: null });
    expect(await client.balance()).toEqual({ available: '0', held: '0' });
    const recent = await loadRecentPayments(client, new Date());
    expect(recent).toEqual({ payments: [], complete: true });
    expect(summarizeSpend(recent.payments, new Date())).toMatchObject({ today: 0n, window: 0n, calls: 0 });

    // A payment key from the form, shown once; then its limits change, and it is revoked (AK-6, AK-8)
    const form = toKeyLimits({ ...emptyKeyForm, label: 'console-agent', dailyBudget: '2', maxPrice: '0.05' }, 'create', new Date());
    if (!('limits' in form))
      throw new Error(form.problem);
    const created = await client.createKey(form.limits);
    expect(created).toMatchObject({ label: 'console-agent', dailyBudget: '2', maxPrice: '0.05', allowance: null, remaining: { dailyBudget: '2' } });
    expect(created.key).toEqual(expect.any(String));
    expect(await client.updateKey(created.id, { allowance: '10', maxPrice: null })).toMatchObject({ allowance: '10', maxPrice: null });
    await client.revokeKey(created.id);
    expect((await client.keys()).map(key => [key.id, key.revokedAt === null])).toEqual([[created.id, false]]);

    // A seller's service, submitted outside the console, with two revisions
    const id = 'console-weather';
    expect(await submit(signup.masterKey, id, serviceYaml(id, 'Console Weather', '0.001'))).toBe(201);
    expect(await submit(signup.masterKey, id, serviceYaml(id, 'Console Weather Pro', '0.002'))).toBe(200);
    expect(await client.services()).toEqual([expect.objectContaining({ id, title: 'Console Weather Pro', revision: 2 })]);
    const detail = await client.service(id);
    expect(detail.config.text).toContain('Console Weather Pro');
    expect((await client.revisions(id)).map(revision => [revision.number, revision.active])).toEqual([[2, true], [1, false]]);

    // Ownership: the host doesn't list the token yet; once it does, a check verifies it (OV-6, OV-7)
    const status = await client.status(detail);
    expect(status.sample).toBe(false);
    expect(status.value.hosts).toEqual([expect.objectContaining({ host, state: 'unverified' })]);
    expect(status.value.notices.map(notice => notice.code)).toContain('host_unverified');
    files.publishTokens(host, [status.value.verificationToken]);
    const verified = await client.verify(detail);
    expect(verified.value.hosts).toEqual([expect.objectContaining({ host, state: 'verified', problem: null })]);

    // Rollback to revision 1 (SR-7), and earnings, none yet (LG-10)
    expect(await client.rollback(id, 1)).toMatchObject({ revision: 1 });
    expect(await client.services()).toEqual([expect.objectContaining({ id, title: 'Console Weather', revision: 1 })]);
    const earnings = await client.earnings(id);
    expect(earnings).toMatchObject({ serviceId: id, calls: 0, earned: { total: '0' }, pending: '0', nextPayoutDate: expect.stringMatching(/^\d{4}-\d{2}-01$/) });
    expect(totalEarnings([earnings])).toMatchObject({ earned: '0', calls: 0 });

    // A new master key replaces the one in the tab; the old one signs out on its next call (AK-5)
    const rotated = await client.rotateMasterKey();
    expect(rotated).not.toBe(signup.masterKey);
    await expect(client.account()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    client = consoleFor(rotated);
    expect((await client.account()).id).toBe(signup.id);

    // Every answer, errors included, let the website read it
    expect(answers.length).toBeGreaterThanOrEqual(19);
    expect(new Set(answers.map(answer => answer.method))).toEqual(new Set(['GET', 'POST', 'PATCH', 'DELETE']));
    expect(answers.filter(answer => answer.allowOrigin !== website)).toEqual([]);
  });

  it('refuses a payment key with the API\'s wrong_key_type message, which the sign-in page shows', async () => {
    const signup = await signUp(apiUrl, browserFetch);
    const paymentKey = await createHttpConsoleApi({ apiUrl, key: signup.masterKey, statusMocked: false, fetch: browserFetch }).createKey({});

    const refused = createHttpConsoleApi({ apiUrl, key: paymentKey.key, statusMocked: false, fetch: browserFetch }).account();

    await expect(refused).rejects.toMatchObject({ status: 401, code: 'wrong_key_type', message: expect.stringMatching(/master key/i) });
  });
});
