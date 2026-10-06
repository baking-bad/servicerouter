import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAddressPolicy, createLogger, OutboundHttp, Secret } from '@servicerouter/common';
import { createDepositAddressDeriver, loadPlatformConfig, openApiFetchLimits, type PlatformConfig } from '@servicerouter/core';
import {
  createFakeOwnershipFiles, createFakeResolver, createTestDatabase, createTestDepositWallet, createTestRedis, createTestSecretKeys, startFakeUpstream,
  type FakeOwnershipFiles, type FakeUpstream, type TestDatabase, type TestDepositWallet, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createApp, type ApiServer } from '../../src/app.js';
import { startApi } from '../../src/start.js';

// The Platform API's events (L-7): IDs and codes only, never a key, a secret, an email, or a token

const internalSecret = 'internal-secret-for-the-api-logs-0123456789';
const sellerSecret = 'sk-seller-upstream-secret-0123456789';
const rotatedSecret = 'sk-seller-rotated-secret-9876543210';
const email = 'private-seller@example.com';
const payoutAddress = 'addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5';
const generous = { requests: 1000, windowSeconds: 60 };

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let keys: TestSecretKeys;
let wallet: TestDepositWallet;
let upstream: FakeUpstream;
let files: FakeOwnershipFiles;
let http: OutboundHttp;
let api: ApiServer;
let url: string;
// Every line the API writes, debug included
const lines: Record<string, unknown>[] = [];

const openapi = (title: string) => ({
  openapi: '3.1.0',
  info: { title, version: '1' },
  paths: { '/forecast/{city}': { get: { operationId: 'getForecast', summary: '14-day forecast', responses: { 200: { description: 'OK' } } } } },
});

beforeAll(async () => {
  [database, redis, keys, upstream] = await Promise.all([createTestDatabase(), createTestRedis(), createTestSecretKeys(), startFakeUpstream({ hosts: ['api.example.com'] })]);
  wallet = createTestDepositWallet();
  config = await loadPlatformConfig({
    env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from(JSON.stringify({ rateLimits: { signup: generous, assistant: generous } })).toString('base64') },
  });
  files = createFakeOwnershipFiles();
  upstream.handle((request, response) => {
    if (files.handle(request, response))
      return;
    const path = request.path.split('?')[0];
    if (path === '/openapi.json')
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(openapi('Forecast')));
    else
      response.writeHead(404).end();
  });
  http = new OutboundHttp({
    ownHosts: config.ownHosts, resolver: createFakeResolver({ 'api.example.com': '127.0.0.1' }), addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: upstream.ca, connectTimeoutMs: openApiFetchLimits.connectTimeoutMs,
  });
  api = createApp({
    config,
    logger: createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }),
    postgres: database.postgres,
    redis,
    sealer: keys.sealer,
    openApiHttp: http,
    ownershipHttp: http,
    ownershipFileUrl: host => upstream.url(host, '/.well-known/servicerouter.json'),
    internalSecret: Secret.from(internalSecret),
    depositAddresses: createDepositAddressDeriver({ accountPublicKey: wallet.accountPublicKey, network: config.deposits!.network }),
  });
  url = `http://127.0.0.1:${(await api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 })).port}`;
});

afterAll(async () => {
  await api?.close();
  await http?.close();
  await upstream?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

let counter = 0;
const call = async (method: string, path: string, { key, body, requestId = `api-logs-${++counter}` }: { key?: string; body?: unknown; requestId?: string } = {}) => {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      'x-request-id': requestId,
      ...key === undefined ? {} : { authorization: `Bearer ${key}` },
      ...body === undefined ? {} : { 'content-type': 'application/json' },
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  });

  return { status: response.status, body: await response.json() as Record<string, any>, requestId };
};

const lineOf = (requestId: string, msg: string) => lines.find(line => line['requestId'] === requestId && line['msg'] === msg);

const serviceYaml = (id: string, { openapiPath = '/openapi.json', title = 'Forecast' } = {}) => `servicerouter:
  version: "1"

service:
  id: ${id}
  title: ${title}
  description: Forecasts.
  category: weather

payouts:
  default:
    asset: cardano-usdm
    address: ${payoutAddress}

payments:
  default:
    amount: "0.001"

upstreams:
  - baseUrl: ${upstream.url('api.example.com', '/v1')}
    openapi: ${upstream.url('api.example.com', openapiPath)}
    auth: main-key

credentials:
  main-key:
    type: http
    scheme: bearer
    secret: main-key
`;

let seller: { id: string; masterKey: string; topupUrl: string };

describe('accounts and keys (L-7)', () => {
  it('logs a signup with the account\'s ID and its new deposit address, never the email or the key', async () => {
    const signup = await call('POST', '/v1/accounts', { body: { email } });
    seller = signup.body as typeof seller;

    expect(signup.status).toBe(201);
    expect(lineOf(signup.requestId, 'An account was created')).toMatchObject({ level: 30, accountId: seller.id });
    expect(lineOf(signup.requestId, 'A deposit address was created')).toMatchObject({ level: 30, accountId: seller.id, network: 'cardano:preprod', derivationIndex: expect.any(Number) });
  });

  it('logs a master key rotation with the revoked key\'s ID', async () => {
    const before = await call('POST', '/v1/accounts');
    const rotated = await call('POST', '/v1/account/master-key/rotate', { key: before.body['masterKey'] });

    expect(rotated.status).toBe(200);
    expect(lineOf(rotated.requestId, 'A master key was rotated')).toMatchObject({ level: 30, accountId: before.body['id'], revokedKeyId: expect.stringMatching(/^key_/) });
  });

  it('logs payment keys created, changed, and revoked, with their IDs and the limits\' names', async () => {
    const created = await call('POST', '/v1/keys', { key: seller.masterKey, body: { label: 'agent', dailyBudget: '2' } });
    const keyId = created.body['id'] as string;
    const changed = await call('PATCH', `/v1/keys/${keyId}`, { key: seller.masterKey, body: { maxPrice: '0.01' } });
    const revoked = await call('DELETE', `/v1/keys/${keyId}`, { key: seller.masterKey });

    expect(lineOf(created.requestId, 'A payment key was created')).toMatchObject({ level: 30, accountId: seller.id, keyId, limits: ['label', 'dailyBudget'] });
    expect(lineOf(changed.requestId, 'A payment key was changed')).toMatchObject({ level: 30, accountId: seller.id, keyId, changed: ['maxPrice'] });
    expect(lineOf(revoked.requestId, 'A payment key was revoked')).toMatchObject({ level: 30, accountId: seller.id, keyId });
  });

  it('logs a domain error\'s 4xx code on its request line, at info', async () => {
    const refused = await call('GET', '/v1/account', { key: 'sr_test_not-a-master-key-at-all-0000000000000' });

    expect(refused.status).toBe(401);
    expect(lineOf(refused.requestId, 'Request completed')).toMatchObject({ level: 30, status: 401, code: 'wrong_key_type' });
  });
});

describe('services (L-7)', () => {
  it('logs a submit\'s result, a resubmit\'s, and an invalid one\'s number of problems', async () => {
    const created = await call('PUT', '/v1/services/forecast-logs', { key: seller.masterKey, body: { config: serviceYaml('forecast-logs'), secrets: { 'main-key': sellerSecret } } });
    const again = await call('PUT', '/v1/services/forecast-logs', { key: seller.masterKey, body: { config: serviceYaml('forecast-logs') } });
    const invalid = await call('PUT', '/v1/services/forecast-logs', { key: seller.masterKey, body: { config: serviceYaml('forecast-logs').replace('category: weather', 'category: 42\nunknown: true') } });

    expect(created.status).toBe(201);
    expect(lineOf(created.requestId, 'A service config was submitted')).toMatchObject({
      level: 30, accountId: seller.id, serviceId: 'forecast-logs', result: 'created', revision: 1, state: expect.any(String), warnings: expect.any(Number),
    });
    expect(lineOf(again.requestId, 'A service config was submitted')).toMatchObject({ result: 'unchanged', revision: 1 });
    expect(invalid.status).toBe(400);
    expect(lineOf(invalid.requestId, 'A service config was submitted')).toMatchObject({ level: 30, serviceId: 'forecast-logs', result: 'invalid_config', problems: invalid.body['error'].details.length });
    expect(lineOf(invalid.requestId, 'Request completed')).toMatchObject({ level: 30, status: 400, code: 'invalid_config' });
  });

  it('logs an OpenAPI document that can\'t be fetched with its host, path, and status (L-4)', async () => {
    const missing = await call('PUT', '/v1/services/forecast-missing', { key: seller.masterKey, body: { config: serviceYaml('forecast-missing', { openapiPath: '/missing.json?token=query-secret' }) } });

    expect(missing.status).toBe(400);
    expect(lineOf(missing.requestId, 'A linked OpenAPI document couldn\'t be fetched')).toMatchObject({
      level: 30, host: expect.stringMatching(/^api\.example\.com:\d+$/), method: 'GET', path: '/missing.json', status: 404, durationMs: expect.any(Number),
    });
  });

  it('logs secret rotations and rollbacks with names and revisions only', async () => {
    await call('PUT', '/v1/services/forecast-logs', { key: seller.masterKey, body: { config: serviceYaml('forecast-logs', { title: 'Forecast two' }) } });
    const secret = await call('PUT', '/v1/services/forecast-logs/secrets/main-key', { key: seller.masterKey, body: { value: rotatedSecret } });
    const rollback = await call('POST', '/v1/services/forecast-logs/rollback', { key: seller.masterKey, body: { revision: 1 } });

    expect(secret.status).toBe(200);
    expect(lineOf(secret.requestId, 'A service secret was written')).toMatchObject({ level: 30, serviceId: 'forecast-logs', secretName: 'main-key' });
    expect(rollback.status).toBe(200);
    expect(lineOf(rollback.requestId, 'A service was rolled back')).toMatchObject({ level: 30, serviceId: 'forecast-logs', revision: 1, changed: true });
  });

  it('logs an ownership verification and its outcome: the service\'s state and its hosts\' states', async () => {
    const status = await call('GET', '/v1/services/forecast-logs/status', { key: seller.masterKey });
    files.publishTokens('api.example.com', [status.body['verificationToken']]);

    const verified = await call('POST', '/v1/services/forecast-logs/verify', { key: seller.masterKey });

    expect(verified.status).toBe(200);
    expect(lineOf(verified.requestId, 'A service\'s ownership was verified')).toMatchObject({
      level: 30, serviceId: 'forecast-logs', state: verified.body['state'], hosts: { verified: 1 },
    });
  });
});

describe('config-assistant drafts (L-7)', () => {
  it('logs each draft\'s outcome with the document\'s host and path, never its query', async () => {
    const drafted = await call('POST', '/v1/assistant/drafts', { key: seller.masterKey, body: { openapi: upstream.url('api.example.com', '/openapi.json'), payoutAddress } });
    const missing = await call('POST', '/v1/assistant/drafts', { key: seller.masterKey, body: { openapi: upstream.url('api.example.com', '/none.json?key=draft-query-secret'), payoutAddress } });

    expect(drafted.status).toBe(200);
    expect(lineOf(drafted.requestId, 'A config draft was requested')).toMatchObject({ level: 30, accountId: seller.id, result: 'drafted', path: '/openapi.json', serviceId: drafted.body['id'] });
    expect(missing.status).toBe(400);
    expect(lineOf(missing.requestId, 'A config draft was requested')).toMatchObject({ result: 'fetch_failed', path: '/none.json', status: 404 });
  });
});

describe('the API\'s lines carry no secret (XC-7, rule 10)', () => {
  it('never logs a key, a seller secret, an email, a top-up token, a query, or the shared secret', async () => {
    const payment = await call('POST', '/v1/keys', { key: seller.masterKey, body: {} });
    await call('GET', '/v1/keys', { key: payment.body['key'] });

    const logged = JSON.stringify(lines);
    const topupToken = seller.topupUrl.split('/').at(-1)!;
    for (const secret of [
      seller.masterKey, payment.body['key'], sellerSecret, rotatedSecret, email, topupToken, internalSecret, 'query-secret', 'draft-query-secret', 'Bearer ',
    ])
      expect(logged).not.toContain(secret);
  });
});

describe('the API\'s startup (L-1, L-11)', () => {
  it('logs one line with the commit, the environment, the URLs, the rails, and deposits, at LOG_LEVEL, never a secret', async () => {
    const startLines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => startLines.push(JSON.parse(line) as Record<string, unknown>) });
    const env = {
      CONFIG_PATH: 'config/example.yaml', DATABASE_URL: database.url.expose(), REDIS_URL: redis.url.expose(), SECRETS_PUBLIC_KEY: keys.publicKey.trim().replaceAll('\n', '\\n'),
      INTERNAL_API_SECRET: internalSecret, DEPOSIT_ACCOUNT_PUBLIC_KEY: wallet.accountPublicKey, HOST: '127.0.0.1', PORT: '0', METRICS_PORT: '0', INTERNAL_PORT: '0',
      LOG_LEVEL: 'debug', GIT_SHA: 'abcdef1',
    };

    const app = await startApi({ env, logger });
    await app.close();

    expect(logger.level).toBe('debug');
    expect(startLines.filter(line => line['msg'] === 'Started')).toEqual([expect.objectContaining({
      level: 30, app: 'api', commit: 'abcdef1', logLevel: 'debug', environment: 'staging',
      urls: { website: 'https://staging.servicerouter.ai', api: 'https://api.staging.servicerouter.ai', pay: 'https://pay.staging.servicerouter.ai' },
      rails: expect.objectContaining({ credits: true, mpp: { network: 'eip155:42431' } }),
      deposits: { network: 'cardano:preprod', asset: 'cardano-usdm', confirmations: 15 }, depositAddresses: true, corsOrigins: ['https://staging.servicerouter.ai'],
    })]);
    const logged = JSON.stringify(startLines);
    for (const secret of [internalSecret, wallet.accountPublicKey, database.url.expose(), keys.publicKey.split('\n')[1]!])
      expect(logged).not.toContain(secret);
  });
});
