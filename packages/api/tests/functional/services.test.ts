import { fixtureTime } from '@servicerouter/testing';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAddressPolicy, createLogger, OutboundHttp, parseStrictYaml, type Clock, type Server } from '@servicerouter/common';
import {
  compileServiceRuntime, loadPlatformConfig, openApiFetchLimits, type InvalidationEvent, type OwnershipStatus, type PlatformConfig,
} from '@servicerouter/core';
import {
  auditLog, createRedisInvalidationBus, createServiceRepository, serviceRevisions, services, serviceSecrets, type RedisInvalidationBus,
} from '@servicerouter/db';
import {
  createFakeResolver, createTestDatabase, createTestRedis, createTestSecretKeys, nownodesHosts, nownodesSecretNames,
  nownodesServiceConfig, startFakeUpstream, type FakeUpstream, type TestDatabase, type TestRedis, type TestSecretKeys,
} from '@servicerouter/testing';

import { createApp } from '../../src/app.js';

// The example platform config, which lists the NOWNodes fixture's category, with room for every signup here
const loadConfig = () => loadPlatformConfig({
  env: {
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: Buffer.from(JSON.stringify({ rateLimits: { signup: { requests: 1000, windowSeconds: 60 } } })).toString('base64'),
  },
});

const weatherOpenApi = {
  openapi: '3.1.0',
  info: { title: 'Weather', version: '1.0.0' },
  paths: {
    '/weather/{city}': { get: { operationId: 'getWeather', responses: { 200: { description: 'OK' } } } },
    '/forecast/{city}': { get: { operationId: 'getForecast' } },
  },
};
const upstreamHosts = ['api.example.com', 'files.example.com', 'moved.example.com', ...nownodesHosts];
const payoutAddress = 'addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5';
const otherPayoutAddress = 'addr_test1vqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygxrcya6';

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let keys: TestSecretKeys;
let upstream: FakeUpstream;
let http: OutboundHttp;
let bus: RedisInvalidationBus;
let url: string;
const events: InvalidationEvent[] = [];
const logs: string[] = [];
const servers: Server[] = [];
let counter = 0;

// One millisecond per reading, so the audit entries of one request sort in the order they were written
let tick = Date.parse(fixtureTime(-4, 1, 0, 0, 0, 0));
const clock: Clock = { now: () => new Date(tick++) };

const startApp = async (ownership?: OwnershipStatus): Promise<string> => {
  const logger = createLogger({}, { write: (line: string) => logs.push(line) });
  const server = createApp({ config, logger, postgres: database.postgres, redis, clock, sealer: keys.sealer, openApiHttp: http, ownership });
  servers.push(server);
  const { port } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

  return `http://127.0.0.1:${port}`;
};

beforeAll(async () => {
  [database, redis, config, keys, upstream] = await Promise.all([
    createTestDatabase(), createTestRedis(), loadConfig(), createTestSecretKeys(), startFakeUpstream({ hosts: upstreamHosts }),
  ]);
  upstream.handle((request, response) => {
    if (request.path !== '/openapi.json') {
      response.writeHead(404).end('BODY-MARKER-do-not-echo');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(weatherOpenApi));
  });
  // The fake upstream listens on 127.0.0.1: only this test's Outbound HTTP may reach loopback
  http = new OutboundHttp({
    ownHosts: config.ownHosts,
    resolver: createFakeResolver(Object.fromEntries(upstreamHosts.map(host => [host, '127.0.0.1']))),
    addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: upstream.ca,
    connectTimeoutMs: openApiFetchLimits.connectTimeoutMs,
  });
  bus = createRedisInvalidationBus({ redis, logger: createLogger({ level: 'silent' }) });
  await bus.subscribe(event => {
    events.push(event);
  });
  url = await startApp();
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await bus?.close();
  await http?.close();
  await upstream?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// --- Helpers ---

const nextId = (): string => {
  counter += 1;

  return `svc-${counter}`;
};

interface ConfigOptions {
  readonly id: string;
  readonly amount?: string;
  readonly mainHost?: string;
  readonly filesHost?: string;
  readonly filesSecret?: string;
  readonly address?: string;
}

const serviceYaml = ({ id, amount = '0.001', mainHost = 'api.example.com', filesHost = 'files.example.com', filesSecret = 'files-key', address = payoutAddress }: ConfigOptions): string => `servicerouter:
  version: "1"

service:
  id: ${id}
  title: Weather
  description: Weather forecasts.
  category: weather

payouts:
  default:
    asset: cardano-usdm
    address: ${address}

payments:
  default:
    amount: "${amount}"

upstreams:
  - baseUrl: ${upstream.url(mainHost, '')}
    name: main
    openapi: ${upstream.url(mainHost, '/openapi.json')}
    auth: main-key

  - baseUrl: ${upstream.url(filesHost, '')}
    name: files
    paths:
      /upload:
        post:
          operationId: uploadFile
    auth: files-key

credentials:
  main-key:
    type: http
    scheme: bearer
    secret: weather-key
  files-key:
    type: apiKey
    in: header
    name: X-Api-Key
    secret: ${filesSecret}
`;

const origin = (host: string) => new URL(upstream.url(host)).origin;
const lineOf = (text: string, needle: string) => text.split('\n').findIndex(line => line.includes(needle)) + 1;
const columnOf = (text: string, needle: string, within = needle) => text.split('\n')[lineOf(text, needle) - 1]!.indexOf(within) + 1;

const signup = async (): Promise<string> => {
  const response = await fetch(`${url}/v1/accounts`, { method: 'POST' });

  return (await response.json() as { masterKey: string }).masterKey;
};

const accountOf = async (key: string): Promise<string> => {
  const response = await fetch(`${url}/v1/account`, { headers: { authorization: `Bearer ${key}` } });

  return (await response.json() as { id: string }).id;
};

interface Answer {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

const responses: string[] = [];

const call = async (key: string | undefined, method: string, path: string, body?: string, contentType = 'application/json', headers: Record<string, string> = {}): Promise<Answer> => {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'content-type': contentType }), ...headers },
    body,
  });
  const text = await response.text();
  responses.push(text);

  return { status: response.status, text, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
};

const submitYaml = (key: string, id: string, yaml: string, contentType = 'application/yaml', headers?: Record<string, string>) =>
  call(key, 'PUT', `/v1/services/${id}`, yaml, contentType, headers);

const envelope = (config: unknown, secrets?: Record<string, string | null>) => JSON.stringify(secrets === undefined ? { config } : { config, secrets });

const submitEnvelope = (key: string, id: string, config: unknown, secrets?: Record<string, string | null>, headers?: Record<string, string>) =>
  call(key, 'PUT', `/v1/services/${id}`, envelope(config, secrets), 'application/json', headers);

const secretValue = () => `sk-live-${counter}-${Math.random().toString(36).slice(2)}-do-not-leak`;

const secretRows = (id: string) => database.db.select().from(serviceSecrets).where(eq(serviceSecrets.serviceId, id)).orderBy(serviceSecrets.name);
const revisionRows = (id: string) => database.db.select().from(serviceRevisions).where(eq(serviceRevisions.serviceId, id)).orderBy(serviceRevisions.number);
const serviceRow = async (id: string) => (await database.db.select().from(services).where(eq(services.id, id)))[0];
const auditActions = async (id: string) => (await database.db.select().from(auditLog)
  .where(and(eq(auditLog.subjectKind, 'service'), eq(auditLog.subjectId, id)))
  .orderBy(auditLog.occurredAt, auditLog.id)).map(entry => entry.action);

// Opens a stored row the way the proxy will, with an origin it chooses (SC-10)
const openRow = async (id: string, name: string, withOrigin: string): Promise<string> => {
  const loaded = await createServiceRepository({ db: database.db }).loadForServing(id);
  const secret = loaded!.secrets.find(item => item.name === name)!;

  return keys.opener.open({ serviceId: id, name, origin: withOrigin, sealed: secret.sealed }).expose();
};

// Every row of every table the API writes, as text
const everything = async (): Promise<string> => {
  const tables = ['accounts', 'api_keys', 'services', 'service_revisions', 'service_secrets', 'audit_log'];
  const dumps = await Promise.all(tables.map(table => database.db.execute(sql.raw(`select row_to_json(t)::text as row from ${table} t`))));

  return dumps.flatMap(dump => dump.rows.map(row => String(row['row']))).join('\n');
};

const waitForEvent = async (id: string, count = 1) => {
  await vi.waitFor(() => expect(events.filter(event => event.kind === 'service' && event.id === id)).toHaveLength(count));
};

// --- Tests ---

describe('PUT /v1/services/{id}: errors (SR-2, PA-3, step 2 D1)', () => {
  it('answers an invalid YAML config with 400 invalid_config and every schema error, each with its line and column', async () => {
    const key = await signup();
    const id = nextId();
    const yaml = serviceYaml({ id })
      .replace('  title: Weather\n', `  title: ${'T'.repeat(61)}\n  colour: blue\n`)
      .replace('    amount: "0.001"', '    amount: "a lot"');

    const { status, body } = await submitYaml(key, id, yaml);

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'invalid_config', message: 'The config has 3 problems. Fix every one in details and submit it again', warnings: [] } });
    expect((body['error'] as { details: unknown }).details).toEqual([
      { path: '/service/title', line: lineOf(yaml, '  title: T'), column: 10, message: expect.any(String) },
      { path: '/service/colour', line: lineOf(yaml, 'colour: blue'), column: 3, message: 'unknown field' },
      { path: '/payments/default/amount', line: lineOf(yaml, 'amount: "a lot"'), column: 13, message: expect.any(String) },
    ]);
    expect(await serviceRow(id)).toBeUndefined();
  });

  it('reports every semantic error with its line and column (pass 2)', async () => {
    const key = await signup();
    const id = nextId();
    const yaml = `${serviceYaml({ id }).replace('category: weather', 'category: sports')}\nroutes:\n  getNothing:\n    enabled: false\n`;

    const { status, body } = await submitYaml(key, id, yaml);

    expect(status).toBe(400);
    expect((body['error'] as { details: unknown }).details).toEqual([
      { path: '/service/category', line: lineOf(yaml, 'category: sports'), column: 13, message: expect.stringContaining('is not a platform category') },
      { path: '/routes/getNothing', line: lineOf(yaml, 'getNothing:'), column: 3, message: 'no upstream has an operation with operationId "getNothing"' },
    ]);
  });

  it('reports a YAML syntax error with its line and column, quoting nothing', async () => {
    const key = await signup();
    const id = nextId();
    const yaml = serviceYaml({ id }).replace('  title: Weather', '  title: [Weather');

    const { status, body } = await submitYaml(key, id, yaml);

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'invalid_config', details: [{ path: '', line: expect.any(Number), column: expect.any(Number) }] } });
  });

  it('gives lines and columns for a JSON config, for a YAML string in an envelope, and for a config object in an envelope', async () => {
    const key = await signup();
    const id = nextId();
    const yaml = serviceYaml({ id }).replace('category: weather', 'category: sports');
    const object = parseStrictYaml(yaml).value;
    const json = JSON.stringify(object, null, 2);
    const wrapped = JSON.stringify({ config: object, secrets: { 'weather-key': 'x-value' } }, null, 2);

    const asJson = await call(key, 'PUT', `/v1/services/${id}`, json);
    const asYamlString = await submitEnvelope(key, id, yaml);
    const asObject = await call(key, 'PUT', `/v1/services/${id}`, wrapped);

    const detail = (answer: Answer) => (answer.body['error'] as { details: readonly unknown[] }).details[0];
    expect(detail(asJson)).toEqual({ path: '/service/category', line: lineOf(json, '"category"'), column: columnOf(json, '"category"', '"sports"'), message: expect.any(String) });
    expect(detail(asYamlString)).toEqual({ path: '/service/category', line: lineOf(yaml, 'category: sports'), column: 13, message: expect.any(String) });
    expect(detail(asObject)).toEqual({ path: '/service/category', line: lineOf(wrapped, '"category"'), column: columnOf(wrapped, '"category"', '"sports"'), message: expect.any(String) });
  });

  it('answers a config whose service.id isn\'t the URL\'s with 400 service_id_mismatch', async () => {
    const key = await signup();

    const { status, body } = await submitYaml(key, nextId(), serviceYaml({ id: 'someone-else' }));

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'service_id_mismatch' } });
  });

  it('answers an OpenAPI link that fails with invalid_config at the link, naming the host and nothing from the response (SR-3)', async () => {
    const key = await signup();
    const id = nextId();
    const yaml = serviceYaml({ id }).replace('/openapi.json', '/missing.json');

    const { status, body, text } = await submitYaml(key, id, yaml);

    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: 'invalid_config',
        details: [{
          path: '/upstreams/0/openapi',
          line: lineOf(yaml, '/missing.json'),
          message: 'the linked OpenAPI document can\'t be fetched: api.example.com answered with status 404',
        }],
      },
    });
    expect(text).not.toContain('BODY-MARKER');
  });

  it.each([
    ['invalid JSON', '{"config":', 'The request body is not valid JSON'],
    ['secrets that aren\'t an object', '{"config":"x","secrets":["a"]}', '"secrets" must map secret names to values, or to null to delete one'],
    ['a secret that isn\'t a string', '{"config":"x","secrets":{"weather-key":42}}', 'The secret "weather-key" must be a string, or null to delete it'],
    ['an empty secret', '{"config":"x","secrets":{"weather-key":""}}', 'The secret "weather-key" is empty'],
    ['a secret with a line break', '{"config":"x","secrets":{"weather-key":"a\\nb"}}', 'The secret "weather-key" contains a control character, such as a line break'],
    ['a malformed secret name', '{"config":"x","secrets":{"sk-LIVE value":"a"}}', 'Every key of "secrets" must be a secret name: 1–64 lowercase letters, digits, hyphens, or underscores'],
    ['another envelope field', '{"config":"x","extra":1}', 'The envelope takes only "config" and "secrets"'],
    ['a config that is a number', '{"config":5}', '"config" must be the config as YAML or JSON text, or as a JSON object'],
  ])('answers %s in a JSON body with 400 invalid_request, quoting no value', async (_case, body, message) => {
    const key = await signup();

    const answer = await call(key, 'PUT', `/v1/services/${nextId()}`, body);

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: { code: 'invalid_request', message } });
  });

  it('answers another media type with 415, and a body over 2 MiB with 413', async () => {
    const key = await signup();
    const id = nextId();

    const plain = await submitYaml(key, id, serviceYaml({ id }), 'text/plain');
    const large = await submitYaml(key, id, `${serviceYaml({ id })}#${'x'.repeat(2 * 1024 * 1024)}\n`);

    expect(plain).toMatchObject({ status: 415, body: { error: { code: 'unsupported_media_type' } } });
    expect(large).toMatchObject({ status: 413, body: { error: { code: 'request_too_large' } } });
  });

  it('needs the master key (PA-2)', async () => {
    const id = nextId();

    const answer = await call(undefined, 'PUT', `/v1/services/${id}`, serviceYaml({ id }), 'application/yaml');

    expect(answer).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } });
  });
});

describe('PUT /v1/services/{id}: submit (SR-3, SR-4, SR-11, SR-12, PA-1)', () => {
  it.each(['application/yaml', 'application/x-yaml', 'text/yaml', 'application/yaml; charset=utf-8'])('creates the service from %s with 201, live, revision 1 (SR-8, S2-D1)', async contentType => {
    const key = await signup();
    const id = nextId();

    const { status, body } = await submitYaml(key, id, serviceYaml({ id }), contentType);

    expect(status).toBe(201);
    expect(body).toEqual({ id, revision: 1, changed: true, state: 'live', warnings: expect.any(Array) });
  });

  it('takes the config as JSON, and as a JSON object in an envelope', async () => {
    const key = await signup();
    const [first, second] = [nextId(), nextId()];
    const object = (id: string) => parseStrictYaml(serviceYaml({ id })).value;

    const json = await call(key, 'PUT', `/v1/services/${first}`, JSON.stringify(object(first)));
    const wrapped = await submitEnvelope(key, second, object(second));

    expect([json.status, wrapped.status]).toEqual([201, 201]);
    expect((await revisionRows(first))[0]).toMatchObject({ configMediaType: 'application/json' });
    expect((await revisionRows(second))[0]).toMatchObject({ configMediaType: 'application/json', configText: JSON.stringify(object(second), null, 2) });
  });

  it('returns warnings on success, with their lines and columns', async () => {
    const key = await signup();
    const id = nextId();
    const yaml = serviceYaml({ id });

    const { status, body } = await submitYaml(key, id, yaml);

    expect(status).toBe(201);
    expect(body['warnings']).toEqual([
      { path: '/credentials/main-key/secret', line: lineOf(yaml, 'secret: weather-key'), column: 13, message: expect.stringContaining('"weather-key" is not set') },
      { path: '/credentials/files-key/secret', line: lineOf(yaml, 'secret: files-key'), column: 13, message: expect.stringContaining('"files-key" is not set') },
    ]);
  });

  it('warns about secrets by the names already set plus those sent, minus those deleted', async () => {
    const key = await signup();
    const id = nextId();
    const warnedFor = (answer: Answer) => (answer.body['warnings'] as readonly { path: string }[]).map(warning => warning.path);

    const sent = await submitEnvelope(key, id, serviceYaml({ id }), { 'weather-key': secretValue() });
    const stored = await submitYaml(key, id, serviceYaml({ id }));
    const deleted = await submitEnvelope(key, id, serviceYaml({ id }), { 'weather-key': null });

    expect(warnedFor(sent)).toEqual(['/credentials/files-key/secret']);
    expect(warnedFor(stored)).toEqual(['/credentials/files-key/secret']);
    expect(warnedFor(deleted)).toEqual(['/credentials/main-key/secret', '/credentials/files-key/secret']);
  });

  it('numbers concurrent submits to one service one after another', async () => {
    const key = await signup();
    const id = nextId();
    await submitYaml(key, id, serviceYaml({ id }));

    const answers = await Promise.all(['0.002', '0.003', '0.004'].map(amount => submitYaml(key, id, serviceYaml({ id, amount }))));

    expect(answers.map(answer => answer.status)).toEqual([200, 200, 200]);
    expect(answers.map(answer => answer.body['revision']).sort()).toEqual([2, 3, 4]);
    expect((await revisionRows(id)).map(row => row.number)).toEqual([1, 2, 3, 4]);
  });

  it('stores the config as submitted, the parsed config, and the OpenAPI snapshot in the revision (SR-3, SR-4)', async () => {
    const key = await signup();
    const id = nextId();
    const yaml = `# Comments stay in the config as submitted\n${serviceYaml({ id })}`;

    await submitYaml(key, id, yaml);

    const [revision] = await revisionRows(id);
    expect(revision).toMatchObject({
      number: 1,
      configText: yaml,
      configMediaType: 'application/yaml',
      config: expect.objectContaining({ service: expect.objectContaining({ id }) }),
      openapiDocuments: { [upstream.url('api.example.com', '/openapi.json')]: weatherOpenApi },
      createdBy: await accountOf(key),
    });
  });

  it('writes service.submit and service.activate with the request ID, and publishes the invalidation event (SR-7, SR-11)', async () => {
    const key = await signup();
    const id = nextId();

    await submitYaml(key, id, serviceYaml({ id }), 'application/yaml', { 'x-request-id': `submit-${id}` });

    const entries = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, id)).orderBy(auditLog.occurredAt, auditLog.id);
    expect(entries.map(entry => [entry.action, entry.requestId, entry.actorId])).toEqual([
      ['service.submit', `submit-${id}`, await accountOf(key)],
      ['service.activate', `submit-${id}`, await accountOf(key)],
    ]);
    expect(entries[1]?.details).toEqual({ revision: 1, previousRevision: null, state: 'live', payoutsChanged: false });
    await waitForEvent(id);
  });

  it('creates one revision for the same config sent twice: the second answers changed: false, and its secrets are still written (SR-4, SR-12)', async () => {
    const key = await signup();
    const id = nextId();
    const [first, second] = [secretValue(), secretValue()];
    await submitEnvelope(key, id, serviceYaml({ id }), { 'weather-key': first });
    const [before] = await secretRows(id);
    await waitForEvent(id);

    // Other formatting, comments, and media type: the same parsed config
    const again = await submitEnvelope(key, id, `# Sent again\n${serviceYaml({ id })}`, { 'weather-key': second });

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ revision: 1, changed: false, state: 'live' });
    expect(await revisionRows(id)).toHaveLength(1);
    expect(await openRow(id, 'weather-key', origin('api.example.com'))).toBe(second);
    expect((await secretRows(id))[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
    expect(await auditActions(id)).toEqual(['service.submit', 'secret.write', 'service.activate', 'service.submit', 'secret.write']);
    // The secret changed, so the proxy must reload (SC-7)
    await waitForEvent(id, 2);
  });

  it('answers changed: false and publishes nothing for the same config without secrets', async () => {
    const key = await signup();
    const id = nextId();
    await submitYaml(key, id, serviceYaml({ id }));
    await waitForEvent(id);

    const again = await submitYaml(key, id, serviceYaml({ id }));

    expect(again.body).toMatchObject({ revision: 1, changed: false });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(events.filter(event => event.id === id)).toHaveLength(1);
  });

  it('applies a price change at once as a new active revision, which the proxy\'s repository call compiles with the new price (SR-10)', async () => {
    const key = await signup();
    const id = nextId();
    await submitYaml(key, id, serviceYaml({ id, amount: '0.001' }));
    const fetchesBefore = upstream.requests.length;

    const changed = await submitYaml(key, id, serviceYaml({ id, amount: '0.25' }));
    const loaded = await createServiceRepository({ db: database.db }).loadForServing(id);
    const compiled = compileServiceRuntime({ ...loaded!, platform: config });

    expect(changed.body).toMatchObject({ revision: 2, changed: true, state: 'live' });
    expect(loaded).toMatchObject({ revision: 2, state: 'live' });
    expect(compiled.ok && compiled.runtime.operations.map(operation => [operation.routeKey, operation.price])).toEqual([
      ['getWeather', 250_000n], ['getForecast', 250_000n], ['uploadFile', 250_000n],
    ]);
    // The submit fetched the document once; loading the revision fetches nothing (SR-3)
    expect(upstream.requests.length).toBe(fetchesBefore + 1);
  });

  it('activates a payout change at once until step 8, and records it on the activation (SR-13)', async () => {
    const key = await signup();
    const id = nextId();
    await submitYaml(key, id, serviceYaml({ id }));

    const changed = await submitYaml(key, id, serviceYaml({ id, address: otherPayoutAddress }));

    expect(changed.body).toMatchObject({ revision: 2, changed: true });
    expect((await serviceRow(id))?.activeRevision).toBe(2);
    const [activation] = await database.db.select().from(auditLog)
      .where(and(eq(auditLog.subjectId, id), eq(auditLog.action, 'service.activate'), sql`(${auditLog.details}->>'revision')::int = 2`));
    expect(activation?.details).toMatchObject({ payoutsChanged: true });
  });

  it('activates pending while a host is unverified (SR-8)', async () => {
    const pendingUrl = await startApp({ allHostsVerified: async () => false });
    const key = await signup();
    const id = nextId();

    const response = await fetch(`${pendingUrl}/v1/services/${id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/yaml' },
      body: serviceYaml({ id }),
    });

    expect(await response.json()).toMatchObject({ revision: 1, state: 'pending' });
    expect((await serviceRow(id))?.state).toBe('pending');
  });
});

describe('secrets in the submit envelope (SC-2, SC-6, SC-8, SC-9, step 2 D2)', () => {
  it('stores each secret sealed for its upstream\'s origin, with only its name in the revision, and never shows the value', async () => {
    const key = await signup();
    const id = nextId();
    const [weather, files] = [secretValue(), secretValue()];

    const { status, text } = await submitEnvelope(key, id, serviceYaml({ id }), { 'weather-key': weather, 'files-key': files });

    expect(status).toBe(201);
    const rows = await secretRows(id);
    expect(rows.map(row => [row.name, row.origin, row.keyId, row.version])).toEqual([
      ['files-key', origin('files.example.com'), keys.sealer.keyId, 1],
      ['weather-key', origin('api.example.com'), keys.sealer.keyId, 1],
    ]);
    expect(await openRow(id, 'weather-key', origin('api.example.com'))).toBe(weather);
    expect(await openRow(id, 'files-key', origin('files.example.com'))).toBe(files);
    const [revision] = await revisionRows(id);
    expect(JSON.stringify(revision)).toContain('"secret":"weather-key"');
    for (const value of [weather, files]) {
      expect(text).not.toContain(value);
      expect(JSON.stringify(revision)).not.toContain(value);
      expect(logs.join('\n')).not.toContain(value);
      expect(await everything()).not.toContain(value);
    }
    expect(await auditActions(id)).toEqual(['service.submit', 'secret.write', 'secret.write', 'service.activate']);
    const writes = await database.db.select().from(auditLog).where(and(eq(auditLog.subjectId, id), eq(auditLog.action, 'secret.write')));
    expect(writes.map(entry => entry.details)).toEqual([
      { name: 'weather-key', origin: origin('api.example.com'), keyId: keys.sealer.keyId },
      { name: 'files-key', origin: origin('files.example.com'), keyId: keys.sealer.keyId },
    ]);
  });

  it('deletes a secret sent as null', async () => {
    const key = await signup();
    const id = nextId();
    await submitEnvelope(key, id, serviceYaml({ id }), { 'weather-key': secretValue(), 'files-key': secretValue() });

    const { body } = await submitEnvelope(key, id, serviceYaml({ id }), { 'files-key': null });

    expect(body).toMatchObject({ changed: false });
    expect((await secretRows(id)).map(row => row.name)).toEqual(['weather-key']);
    expect((await auditActions(id)).at(-1)).toBe('secret.delete');
  });

  it('never quotes a secret in a validation error or a log line', async () => {
    const key = await signup();
    const id = nextId();
    const value = secretValue();
    const broken = serviceYaml({ id }).replace('category: weather', 'category: sports');

    const { status, text } = await submitEnvelope(key, id, broken, { 'weather-key': value });

    expect(status).toBe(400);
    expect(text).not.toContain(value);
    expect(logs.join('\n')).not.toContain(value);
  });
});

describe('a failed submit stores nothing (SC-9, step 2 D3)', () => {
  it.each([
    ['fails the schema (pass 1)', (yaml: string) => yaml.replace('    amount: "0.001"', '    amount: "a lot"')],
    ['fails the semantic checks (pass 2)', (yaml: string) => yaml.replace('category: weather', 'category: sports')],
  ])('stores no service, secret, revision, or audit entry when the config %s', async (_case, breakConfig) => {
    const key = await signup();
    const id = nextId();

    const { status } = await submitEnvelope(key, id, breakConfig(serviceYaml({ id })), { 'weather-key': secretValue() });

    expect(status).toBe(400);
    expect([await serviceRow(id), await secretRows(id), await revisionRows(id), await auditActions(id)]).toEqual([undefined, [], [], []]);
  });

  it('keeps the active revision and the stored secrets when a later submit fails validation', async () => {
    const key = await signup();
    const id = nextId();
    const value = secretValue();
    await submitEnvelope(key, id, serviceYaml({ id }), { 'weather-key': value });
    const before = { secrets: await secretRows(id), audit: await auditActions(id) };

    const { status } = await submitEnvelope(key, id, serviceYaml({ id, amount: '0.002' }).replace('category: weather', 'category: sports'), { 'weather-key': secretValue() });

    expect(status).toBe(400);
    expect((await serviceRow(id))?.activeRevision).toBe(1);
    expect(await revisionRows(id)).toHaveLength(1);
    expect(await secretRows(id)).toEqual(before.secrets);
    expect(await auditActions(id)).toEqual(before.audit);
    expect(await openRow(id, 'weather-key', origin('api.example.com'))).toBe(value);
  });

  it('rolls back the secrets, the revision, and the service when a step inside the transaction fails', async () => {
    const key = await signup();
    const id = nextId();
    // The activation's audit entry is the transaction's last write
    await database.db.execute(sql.raw(`
      create function fail_activation() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$;
      create trigger fail_activation before insert on audit_log for each row when (new.action = 'service.activate' and new.subject_id = '${id}')
        execute function fail_activation();
    `));
    try {
      const { status, body } = await submitEnvelope(key, id, serviceYaml({ id }), { 'weather-key': secretValue(), 'files-key': secretValue() });

      expect(status).toBe(500);
      expect(body).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
      expect([await serviceRow(id), await secretRows(id), await revisionRows(id), await auditActions(id)]).toEqual([undefined, [], [], []]);
    }
    finally {
      await database.db.execute(sql.raw('drop trigger fail_activation on audit_log; drop function fail_activation();'));
    }
  });
});

describe('secrets can\'t be read back (SC-1, step 2 D4)', () => {
  it('shows only names and times: never a value, hash, or length, on any endpoint', async () => {
    const key = await signup();
    const id = nextId();
    const [weather, files, rotated] = [secretValue(), secretValue(), secretValue()];
    const before = responses.length;
    await submitEnvelope(key, id, serviceYaml({ id }), { 'weather-key': weather, 'files-key': files });
    await submitYaml(key, id, serviceYaml({ id, amount: '0.002' }));

    const service = await call(key, 'GET', `/v1/services/${id}`);
    await call(key, 'GET', `/v1/services/${id}/revisions`);
    await call(key, 'PUT', `/v1/services/${id}/secrets/weather-key`, JSON.stringify({ value: rotated }));
    await call(key, 'POST', `/v1/services/${id}/rollback`, JSON.stringify({ revision: 1 }));

    expect(service.body['secrets']).toEqual([
      { name: 'files-key', updatedAt: expect.any(String) },
      { name: 'weather-key', updatedAt: expect.any(String) },
    ]);
    const shown = responses.slice(before).join('\n');
    for (const value of [weather, files, rotated])
      expect(shown).not.toContain(value);
    expect(shown).not.toMatch(/"(?:value|hash|length|ciphertext|wrappedKey|iv|tag|keyId)"/);
  });
});

describe('GET /v1/services/{id} and its revisions', () => {
  it('shows the owner the state, the active revision, and its config as submitted', async () => {
    const key = await signup();
    const id = nextId();
    const yaml = `# My config\n${serviceYaml({ id })}`;
    await submitYaml(key, id, yaml);

    const { status, body } = await call(key, 'GET', `/v1/services/${id}`);

    expect(status).toBe(200);
    expect(body).toEqual({
      id,
      state: 'live',
      revision: 1,
      config: { mediaType: 'application/yaml', text: yaml },
      secrets: [],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('lists the revisions newest first, marking the active one', async () => {
    const key = await signup();
    const id = nextId();
    await submitYaml(key, id, serviceYaml({ id }));
    await submitYaml(key, id, serviceYaml({ id, amount: '0.002' }));

    const { body } = await call(key, 'GET', `/v1/services/${id}/revisions`);

    expect(body).toEqual({
      revisions: [
        { number: 2, active: true, mediaType: 'application/yaml', createdBy: await accountOf(key), createdAt: expect.any(String) },
        { number: 1, active: false, mediaType: 'application/yaml', createdBy: await accountOf(key), createdAt: expect.any(String) },
      ],
    });
  });

  it('answers an unknown service with 404 not_found', async () => {
    const key = await signup();

    expect(await call(key, 'GET', '/v1/services/no-such-service')).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    expect(await call(key, 'GET', '/v1/services/no-such-service/revisions')).toMatchObject({ status: 404 });
  });
});

describe('another account\'s service', () => {
  it('answers 403 forbidden to a PUT, and leaves the service as it was', async () => {
    const [owner, other] = [await signup(), await signup()];
    const id = nextId();
    await submitEnvelope(owner, id, serviceYaml({ id }), { 'weather-key': secretValue() });
    const before = { service: await serviceRow(id), secrets: await secretRows(id) };

    const { status, body } = await submitEnvelope(other, id, serviceYaml({ id, amount: '9' }), { 'weather-key': secretValue() });

    expect(status).toBe(403);
    expect(body).toEqual({ error: { code: 'forbidden', message: 'The service belongs to another account' } });
    expect({ service: await serviceRow(id), secrets: await secretRows(id) }).toEqual(before);
    expect(await revisionRows(id)).toHaveLength(1);
  });

  it.each([
    ['GET', '', undefined],
    ['GET', '/revisions', undefined],
    ['POST', '/rollback', '{"revision":1}'],
    ['PUT', '/secrets/weather-key', '{"value":"x-value"}'],
  ])('answers 403 forbidden to %s %s', async (method, suffix, body) => {
    const [owner, other] = [await signup(), await signup()];
    const id = nextId();
    await submitYaml(owner, id, serviceYaml({ id }));

    expect(await call(other, method, `/v1/services/${id}${suffix}`, body)).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
  });
});

describe('POST /v1/services/{id}/rollback (SR-7, SR-11, step 2 D5)', () => {
  it('makes revision 1 active again, which GET shows, and publishes the invalidation event', async () => {
    const key = await signup();
    const id = nextId();
    const first = serviceYaml({ id });
    await submitYaml(key, id, first);
    await submitYaml(key, id, serviceYaml({ id, amount: '0.002' }));
    await waitForEvent(id, 2);

    const rolledBack = await call(key, 'POST', `/v1/services/${id}/rollback`, JSON.stringify({ revision: 1 }), 'application/json', { 'x-request-id': `rollback-${id}` });
    const shown = await call(key, 'GET', `/v1/services/${id}`);

    expect(rolledBack).toMatchObject({ status: 200, body: { id, revision: 1, changed: true, state: 'live' } });
    expect(shown.body).toMatchObject({ revision: 1, config: { text: first } });
    await waitForEvent(id, 3);
    const entries = await database.db.select().from(auditLog).where(eq(auditLog.requestId, `rollback-${id}`)).orderBy(auditLog.id);
    expect(entries.map(entry => entry.action).sort()).toEqual(['service.activate', 'service.rollback']);
    const loaded = await createServiceRepository({ db: database.db }).loadForServing(id);
    expect(loaded?.revision).toBe(1);
  });

  it('answers the active revision with changed: false, and an unknown one with 404', async () => {
    const key = await signup();
    const id = nextId();
    await submitYaml(key, id, serviceYaml({ id }));

    const same = await call(key, 'POST', `/v1/services/${id}/rollback`, JSON.stringify({ revision: 1 }));
    const unknown = await call(key, 'POST', `/v1/services/${id}/rollback`, JSON.stringify({ revision: 7 }));
    const malformed = await call(key, 'POST', `/v1/services/${id}/rollback`, JSON.stringify({ revision: 0 }));

    expect(same.body).toMatchObject({ revision: 1, changed: false });
    expect(unknown).toMatchObject({ status: 404, body: { error: { code: 'not_found', message: 'The service has no revision 7' } } });
    expect(malformed).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
  });
});

describe('PUT /v1/services/{id}/secrets/{name} (SC-1, SC-7, SC-8, SC-10)', () => {
  it('seals the value for the active upstream\'s origin without a new revision, writes the audit log, and publishes', async () => {
    const key = await signup();
    const id = nextId();
    const value = secretValue();
    await submitYaml(key, id, serviceYaml({ id }));
    await waitForEvent(id);

    const { status, body, text } = await call(key, 'PUT', `/v1/services/${id}/secrets/files-key`, JSON.stringify({ value }), 'application/json', { 'x-request-id': `rotate-${id}` });

    expect(status).toBe(200);
    expect(body).toEqual({ name: 'files-key', updatedAt: expect.any(String) });
    expect(text).not.toContain(value);
    expect(await revisionRows(id)).toHaveLength(1);
    expect((await secretRows(id)).map(row => [row.name, row.origin])).toEqual([['files-key', origin('files.example.com')]]);
    expect(await openRow(id, 'files-key', origin('files.example.com'))).toBe(value);
    const [entry] = await database.db.select().from(auditLog).where(eq(auditLog.requestId, `rotate-${id}`));
    expect(entry).toMatchObject({ action: 'secret.write', details: { name: 'files-key', origin: origin('files.example.com'), keyId: keys.sealer.keyId } });
    expect(JSON.stringify(entry)).not.toContain(value);
    expect(logs.join('\n')).not.toContain(value);
    await waitForEvent(id, 2);
  });

  it('answers a name the active revision doesn\'t use with 400 unused_secret, and stores nothing', async () => {
    const key = await signup();
    const id = nextId();
    await submitYaml(key, id, serviceYaml({ id }));

    const { status, body } = await call(key, 'PUT', `/v1/services/${id}/secrets/spare-key`, JSON.stringify({ value: secretValue() }));

    expect(status).toBe(400);
    expect(body).toEqual({
      error: {
        code: 'unused_secret',
        message: 'No upstream in the active revision uses the secret "spare-key", so there is no host to bind it to. Send a secret only with a config that uses it',
      },
    });
    expect(await secretRows(id)).toEqual([]);
  });

  it.each([
    ['a malformed name', 'Bad_Name', '{"value":"x-value"}', 'The secret name must be 1–64 lowercase letters, digits, hyphens, or underscores'],
    ['an empty value', 'files-key', '{"value":""}', 'The secret "files-key" is empty'],
    ['a value with a line break', 'files-key', '{"value":"a\\r\\nb"}', 'The secret "files-key" contains a control character, such as a line break'],
  ])('answers %s with 400 invalid_request', async (_case, name, body, message) => {
    const key = await signup();
    const id = nextId();
    await submitYaml(key, id, serviceYaml({ id }));

    expect(await call(key, 'PUT', `/v1/services/${id}/secrets/${name}`, body)).toMatchObject({ status: 400, body: { error: { code: 'invalid_request', message } } });
  });

  it('answers an unknown service with 404', async () => {
    const key = await signup();

    expect(await call(key, 'PUT', '/v1/services/no-such-service/secrets/files-key', '{"value":"x-value"}')).toMatchObject({ status: 404 });
  });
});

describe('host binding (SC-10)', () => {
  it('refuses a submit that moves an upstream to another host without its secrets, at its baseUrl with line and column, naming them', async () => {
    const key = await signup();
    const id = nextId();
    await submitEnvelope(key, id, serviceYaml({ id }), { 'weather-key': secretValue(), 'files-key': secretValue() });
    const moved = serviceYaml({ id, filesHost: 'moved.example.com' });

    const { status, body } = await submitYaml(key, id, moved);

    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: 'invalid_config',
        details: [{
          path: '/upstreams/1/baseUrl',
          line: lineOf(moved, `baseUrl: ${upstream.url('moved.example.com', '')}`),
          column: 14,
          message: `moves the secret "files-key" from ${origin('files.example.com')} to ${origin('moved.example.com')}. `
            + 'A secret is bound to its host: send it again in this request\'s secrets',
        }],
      },
    });
    expect((await serviceRow(id))?.activeRevision).toBe(1);
  });

  it('accepts the same move with the secret sent again, and the stored row carries the new origin', async () => {
    const key = await signup();
    const id = nextId();
    const value = secretValue();
    await submitEnvelope(key, id, serviceYaml({ id }), { 'weather-key': secretValue(), 'files-key': secretValue() });

    const { status, body } = await submitEnvelope(key, id, serviceYaml({ id, filesHost: 'moved.example.com' }), { 'files-key': value });

    expect(status).toBe(200);
    expect(body).toMatchObject({ revision: 2, changed: true });
    expect((await secretRows(id)).map(row => [row.name, row.origin])).toEqual([
      ['files-key', origin('moved.example.com')],
      ['weather-key', origin('api.example.com')],
    ]);
    expect(await openRow(id, 'files-key', origin('moved.example.com'))).toBe(value);
    await expect(openRow(id, 'files-key', origin('files.example.com'))).rejects.toMatchObject({ code: 'secret_open_failed' });
  });

  it('refuses a secret that upstreams on two hosts use, at each upstream\'s auth', async () => {
    const key = await signup();
    const id = nextId();
    const shared = serviceYaml({ id, filesSecret: 'weather-key' });

    const { status, body } = await submitEnvelope(key, id, shared, { 'weather-key': secretValue() });

    expect(status).toBe(400);
    expect((body['error'] as { details: readonly { path: string }[] }).details.map(detail => detail.path)).toEqual(['/upstreams/0/auth', '/upstreams/1/auth']);
    expect(await serviceRow(id)).toBeUndefined();
  });

  it('refuses a sent secret that the config doesn\'t use with 400 unused_secret, storing nothing', async () => {
    const key = await signup();
    const id = nextId();

    const { status, body } = await submitEnvelope(key, id, serviceYaml({ id }), { 'weather-key': secretValue(), 'spare-key': secretValue(), 'other-key': secretValue() });

    expect(status).toBe(400);
    expect(body).toEqual({
      error: {
        code: 'unused_secret',
        message: 'No upstream in the config uses the secrets "other-key", "spare-key", so there is no host to bind it to. Send a secret only with a config that uses it',
      },
    });
    expect([await serviceRow(id), await secretRows(id)]).toEqual([undefined, []]);
  });

  it('refuses a rollback across a host change with 409 secret_origin_mismatch, naming the secrets, and changes nothing', async () => {
    const key = await signup();
    const id = nextId();
    await submitEnvelope(key, id, serviceYaml({ id }), { 'weather-key': secretValue(), 'files-key': secretValue() });
    await submitEnvelope(key, id, serviceYaml({ id, filesHost: 'moved.example.com' }), { 'files-key': secretValue() });
    await waitForEvent(id, 2);
    const before = { service: await serviceRow(id), secrets: await secretRows(id), audit: await auditActions(id) };

    const { status, body } = await call(key, 'POST', `/v1/services/${id}/rollback`, JSON.stringify({ revision: 1 }));

    expect(status).toBe(409);
    expect(body).toEqual({
      error: {
        code: 'secret_origin_mismatch',
        message: 'The revision sends the secret "files-key" to another host than it is sealed for. Submit the config with it again instead',
      },
    });
    expect({ service: await serviceRow(id), secrets: await secretRows(id), audit: await auditActions(id) }).toEqual(before);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(events.filter(event => event.id === id)).toHaveLength(2);
  });
});

describe('the multi-chain service fixture', () => {
  it('submits the filled-in fixture with a secret per host, and serves from the repository call', async () => {
    const key = await signup();
    const secrets = Object.fromEntries(nownodesSecretNames.map(name => [name, secretValue()]));

    const { status, body } = await submitEnvelope(key, 'nownodes', nownodesServiceConfig({ port: upstream.port }), secrets);

    expect(status).toBe(201);
    expect(body).toEqual({ id: 'nownodes', revision: 1, changed: true, state: 'live', warnings: [] });
    expect((await secretRows('nownodes')).map(row => [row.name, row.origin])).toEqual([
      ['nownodes-base-api-key', origin('base.nownodes.io')],
      ['nownodes-btc-api-key', origin('btcbook.nownodes.io')],
      ['nownodes-eth-api-key', origin('eth.nownodes.io')],
      ['nownodes-sol-api-key', origin('sol.nownodes.io')],
    ]);
    const loaded = await createServiceRepository({ db: database.db }).loadForServing('nownodes');
    const compiled = compileServiceRuntime({ ...loaded!, platform: config });
    expect(compiled.ok && compiled.runtime.operations.map(operation => operation.routeKey)).toEqual([
      'ethRpc', 'baseRpc', 'solRpc', 'btcAddress', 'btcTx', 'btcBlock', 'btcUtxo', 'btcEstimateFee',
    ]);
  });


});
