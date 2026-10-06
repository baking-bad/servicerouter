import { fixtureDay, fixtureTime } from '@servicerouter/testing';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/http';
import { createHttpConsoleApi, signingOutOnUnauthorized, signUp } from '../src/console/api';
import { createSampleConsoleApi } from '../src/console/sample';
import { clearSession, readSession, sessionKey, tabStorage, writeSession, type SessionStorage } from '../src/console/session';
import { loadRecentPayments, summarizeSpend, totalEarnings } from '../src/console/spend';
import type { Earnings, Payment } from '../src/console/types';
import { emptyKeyForm, keyFormOf, toKeyLimits } from '../src/console/ui/keyForm';

const now = new Date(fixtureTime(0, 6, 15, 0, 0, 0));
const dayMs = 86_400_000;
const apiUrl = 'https://api.example.test';
const masterKey = 'srm_test_master_0123456789abcdef';

const memoryStorage = (): SessionStorage & { readonly items: Map<string, string> } => {
  const items = new Map<string, string>();

  return {
    items,
    getItem: name => items.get(name) ?? null,
    setItem: (name, value) => void items.set(name, value),
    removeItem: name => void items.delete(name),
  };
};

const filesUnder = (directory: string): string[] => readdirSync(directory).flatMap(name => {
  const path = join(directory, name);

  return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the console session stays in the tab (WB-8)', () => {
  it('keeps the master key in session storage under one name, and signing out removes it', () => {
    const storage = memoryStorage();

    writeSession(storage, { kind: 'key', key: masterKey });

    expect([...storage.items.keys()]).toEqual([sessionKey]);
    expect(readSession(storage)).toEqual({ kind: 'key', key: masterKey });

    clearSession(storage);

    expect(storage.items.size).toBe(0);
    expect(readSession(storage)).toBeUndefined();
  });

  it('remembers a sample session, and treats anything else stored under its name as signed out', () => {
    const storage = memoryStorage();
    writeSession(storage, { kind: 'sample' });

    expect(readSession(storage)).toEqual({ kind: 'sample' });

    for (const raw of ['not json', '{"kind":"key","key":""}', '{"kind":"key"}', '{"kind":"admin"}', 'null']) {
      storage.setItem(sessionKey, raw);
      expect(readSession(storage)).toBeUndefined();
    }
  });

  it('uses the tab\'s sessionStorage, and none where the browser blocks it', () => {
    const storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);

    expect(tabStorage()).toBe(storage);

    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('SecurityError'); } });

    expect(tabStorage()).toBeUndefined();
  });

  it('never touches localStorage or a cookie anywhere in the console', () => {
    const files = [...filesUnder(join(import.meta.dirname, '../src/console')), ...filesUnder(join(import.meta.dirname, '../app/console'))];

    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\blocalStorage\s*[.[]|document\.cookie|\bcookies\(\)|['\"]set-cookie['\"]/i);
    }
  });
});

const jsonAnswer = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const recordingFetch = (answer: (url: URL, init: RequestInit) => Response = () => jsonAnswer({})) => {
  const calls: { readonly url: URL; readonly method: string; readonly headers: Record<string, string>; readonly body: unknown }[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, method: init.method ?? 'GET', headers: { ...init.headers as Record<string, string> }, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });

    return answer(url, init);
  });

  return { calls, fetch: fetchFn as unknown as typeof fetch };
};

describe('the console\'s Platform API client (WB-8, WB-2)', () => {
  it('sends the master key only to API_URL, in Authorization, never in a URL', async () => {
    const { calls, fetch } = recordingFetch(url => jsonAnswer(url.pathname === '/v1/keys' ? { keys: [] } : url.pathname === '/v1/services' ? { services: [] } : {}));
    const api = createHttpConsoleApi({ apiUrl, key: masterKey, fetch });

    await api.account();
    await api.balance();
    await api.keys();
    await api.createKey({ label: 'agent', dailyBudget: '5' });
    await api.updateKey('key_1', { maxPrice: null });
    await api.revokeKey('key_1');
    await api.payments({ limit: 100, after: 'pay_9' });
    await api.services();
    await api.rollback('my-weather', 2);
    await api.rotateMasterKey();

    expect(calls.map(call => `${call.method} ${call.url.pathname}${call.url.search}`)).toEqual([
      'GET /v1/account',
      'GET /v1/balance',
      'GET /v1/keys',
      'POST /v1/keys',
      'PATCH /v1/keys/key_1',
      'DELETE /v1/keys/key_1',
      'GET /v1/payments?limit=100&after=pay_9',
      'GET /v1/services',
      'POST /v1/services/my-weather/rollback',
      'POST /v1/account/master-key/rotate',
    ]);
    for (const call of calls) {
      expect(call.url.origin).toBe(apiUrl);
      expect(call.headers['authorization']).toBe(`Bearer ${masterKey}`);
      expect(call.url.href).not.toContain(masterKey);
    }
    expect(calls[3]!.body).toEqual({ label: 'agent', dailyBudget: '5' });
    expect(calls[4]!.body).toEqual({ maxPrice: null });
    expect(calls[8]!.body).toEqual({ revision: 2 });
  });

  it('signs up without a key', async () => {
    const { calls, fetch } = recordingFetch(() => jsonAnswer({ id: 'acc_1', masterKey, notice: 'Save it' }, 201));

    const signup = await signUp(apiUrl, fetch);

    expect(signup.masterKey).toBe(masterKey);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.href).toBe(`${apiUrl}/v1/accounts`);
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('reads a signed-in account\'s ownership status from the API, never sample data; only the sample console has sample status (OV-7, WB-10)', async () => {
    const live = recordingFetch(() => jsonAnswer({ id: 'my-weather', verificationToken: 'sr-verify=abc', hosts: [], payoutConfirmation: null, notices: [] }));
    const service = { id: 'my-weather', state: 'live', revision: 2, config: { mediaType: 'application/yaml', text: 'baseUrl: https://api.weather.example\n' }, secrets: [], createdAt: now.toISOString(), updatedAt: now.toISOString() } as const;

    const status = await createHttpConsoleApi({ apiUrl, key: masterKey, fetch: live.fetch }).status(service);
    const verified = await createHttpConsoleApi({ apiUrl, key: masterKey, fetch: live.fetch }).verify(service);

    expect(status).toEqual({ value: expect.objectContaining({ verificationToken: 'sr-verify=abc' }), sample: false });
    expect(verified.sample).toBe(false);
    expect(live.calls.map(call => `${call.method} ${call.url.pathname}`)).toEqual(['GET /v1/services/my-weather/status', 'POST /v1/services/my-weather/verify']);

    const sample = await createSampleConsoleApi(() => now).status(service);

    expect(sample.sample).toBe(true);
    expect(sample.value.hosts.map(host => [host.host, host.state])).toEqual([['api.weather.example', 'verified']]);
  });

  it('keeps the API\'s error code and message (PA-3)', async () => {
    const { fetch } = recordingFetch(() => jsonAnswer({ error: { code: 'wrong_key_type', message: 'This is a payment key. The console takes the master key.' } }, 401));

    await expect(createHttpConsoleApi({ apiUrl, key: 'sr_test_payment', fetch }).account()).rejects.toMatchObject({
      status: 401, code: 'wrong_key_type', message: 'This is a payment key. The console takes the master key.',
    });
  });

  it('signs out on a 401 from any call, and only on a 401', async () => {
    let status = 401;
    const { fetch } = recordingFetch(() => jsonAnswer({ error: { code: 'invalid_key', message: 'The key isn\'t valid' } }, status));
    const onUnauthorized = vi.fn();
    const api = signingOutOnUnauthorized(createHttpConsoleApi({ apiUrl, key: masterKey, fetch }), onUnauthorized);

    await expect(api.revokeKey('key_1')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    status = 404;
    await expect(api.keys()).rejects.toMatchObject({ status: 404 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(api.sample).toBe(false);
  });
});

const payment = (overrides: Partial<Payment> & Pick<Payment, 'amount' | 'createdAt'>): Payment => ({
  id: `pay_${overrides.createdAt}_${overrides.amount}`,
  requestId: null,
  kind: 'service',
  rail: 'credits',
  serviceId: 'skycast-weather',
  routeKey: 'getCurrent',
  targetHost: null,
  targetPath: null,
  status: 'captured',
  updatedAt: overrides.createdAt,
  ...overrides,
});

describe('spend over 30 days, from GET /v1/payments (WB-8)', () => {
  it('counts captured and settled payments by day and by service, and not released, cancelled, held, or failed ones', () => {
    const today = now.toISOString();
    const yesterday = new Date(now.getTime() - dayMs).toISOString();
    const payments = [
      payment({ amount: '0.001', createdAt: today }),
      payment({ amount: '0.002', createdAt: today, rail: 'x402', status: 'settled' }),
      payment({ amount: '0.04', createdAt: today, serviceId: 'pixel-forge' }),
      payment({ amount: '1', createdAt: today, status: 'released' }),
      payment({ amount: '1', createdAt: today, rail: 'mpp', status: 'cancelled' }),
      payment({ amount: '1', createdAt: today, status: 'held' }),
      payment({ amount: '1', createdAt: today, rail: 'x402', status: 'failed' }),
      payment({ amount: '0.5', createdAt: yesterday, kind: 'routed', serviceId: null, routeKey: null, targetHost: 'api.paid.example', targetPath: '/v1/data', rail: 'x402', status: 'settled' }),
      payment({ amount: '0.003', createdAt: yesterday }),
      payment({ amount: '9', createdAt: new Date(now.getTime() - 30 * dayMs).toISOString() }),
    ];

    const spend = summarizeSpend(payments, now);

    expect(spend.today).toBe(43_000n);
    expect(spend.window).toBe(546_000n);
    expect(spend.calls).toBe(5);
    expect(spend.byDay).toHaveLength(30);
    expect(spend.byDay[0]!.day).toBe(fixtureDay(-1, 7));
    expect(spend.byDay.at(-1)).toEqual({ day: fixtureDay(0, 6), amount: 43_000n, calls: 3 });
    expect(spend.byDay.at(-2)).toEqual({ day: fixtureDay(0, 5), amount: 503_000n, calls: 2 });
    expect(spend.byService).toEqual([
      { serviceId: 'api.paid.example', amount: 500_000n, calls: 1 },
      { serviceId: 'pixel-forge', amount: 40_000n, calls: 1 },
      { serviceId: 'skycast-weather', amount: 6_000n, calls: 3 },
    ]);
  });

  it('pages back through payments until they are older than 30 days, and stops at 1,000', async () => {
    const all = Array.from({ length: 250 }, (_, index) => payment({ amount: '0.001', createdAt: new Date(now.getTime() - index * 4 * 3_600_000).toISOString() }));
    const api = {
      payments: vi.fn(async ({ after, limit = 50 }: { readonly after?: string; readonly limit?: number } = {}) => {
        const start = Number(after ?? 0);

        return { payments: all.slice(start, start + limit), next: start + limit < all.length ? String(start + limit) : null };
      }),
    };

    const recent = await loadRecentPayments(api, now);

    // Six a day for 30 days, and the one exactly 30 days old
    expect(recent).toMatchObject({ complete: true });
    expect(recent.payments).toHaveLength(181);
    expect(api.payments).toHaveBeenCalledTimes(2);

    const capped = await loadRecentPayments(api, now, 120);

    expect(capped.complete).toBe(false);
    expect(capped.payments).toHaveLength(120);
  });

  it('adds up earnings across a seller\'s services, in integer micro-USD (CK-4)', () => {
    const earnings = (serviceId: string, total: string, byRail: Earnings['earned']['byRail'], nextPayoutDate: string): Earnings => ({
      serviceId, calls: 10, earned: { total, byRail }, fee: '0.1', paidOut: '0', pending: total, nextPayoutDate,
    });

    expect(totalEarnings([
      earnings('a', '0.3', { credits: '0.1', x402: '0.2' }, fixtureDay(1, 1)),
      earnings('b', '0.000001', { credits: '0.000001' }, fixtureDay(1, 1)),
    ])).toEqual({
      calls: 20, earned: '0.300001', fee: '0.2', pending: '0.300001', paidOut: '0', byRail: { credits: '0.100001', x402: '0.2' }, nextPayoutDate: fixtureDay(1, 1),
    });
    expect(totalEarnings([]).nextPayoutDate).toBeUndefined();
  });
});

describe('the payment key form (WB-8, AK-6)', () => {
  it('leaves out empty limits on create, so the API applies its defaults', () => {
    expect(toKeyLimits({ ...emptyKeyForm, label: '  research-agent ' }, 'create', now)).toEqual({ limits: { label: 'research-agent', dailyBudget: '5' } });
    expect(toKeyLimits({ label: '', dailyBudget: '$2.50', allowance: '20', maxPrice: '0.05', expires: fixtureDay(2, 31) }, 'create', now)).toEqual({
      limits: { dailyBudget: '2.50', allowance: '20', maxPrice: '0.05', expiresAt: fixtureTime(2, 31, 23, 59, 59, 0) },
    });
  });

  it('clears an emptied limit on change with null', () => {
    const key = {
      id: 'key_1', label: 'ci-bot', allowance: '10', dailyBudget: '1', maxPrice: '0.001', expiresAt: fixtureTime(2, 5, 23, 59, 59, 0), createdAt: now.toISOString(),
      revokedAt: null, spent: { today: '0', total: '0' }, remaining: { allowance: '10', dailyBudget: '1' },
    };
    const form = keyFormOf(key);

    expect(form).toEqual({ label: 'ci-bot', dailyBudget: '1', allowance: '10', maxPrice: '0.001', expires: fixtureDay(2, 5) });
    expect(toKeyLimits({ ...form, allowance: '', maxPrice: '', expires: '' }, 'change', now)).toEqual({
      limits: { label: 'ci-bot', dailyBudget: '1', allowance: null, maxPrice: null, expiresAt: null },
    });
  });

  it('names the first problem before anything is sent', () => {
    expect(toKeyLimits({ ...emptyKeyForm, dailyBudget: '' }, 'create', now)).toEqual({ problem: 'Every payment key has a daily budget' });
    expect(toKeyLimits({ ...emptyKeyForm, allowance: 'ten' }, 'create', now)).toEqual({ problem: 'The allowance must be a USD amount, such as 0.05' });
    expect(toKeyLimits({ ...emptyKeyForm, maxPrice: '-1' }, 'create', now)).toEqual({ problem: 'The maximum price must be a USD amount, such as 0.05' });
    expect(toKeyLimits({ ...emptyKeyForm, label: 'x'.repeat(61) }, 'create', now)).toEqual({ problem: 'The label is longer than 60 characters' });
    expect(toKeyLimits({ ...emptyKeyForm, expires: fixtureDay(0, 5) }, 'create', now)).toEqual({ problem: 'The expiry must be a day in the future' });
  });
});

describe('the sample console (WB-10)', () => {
  it('opens every view with fixtures and no account, labeled as sample data', async () => {
    const api = createSampleConsoleApi(() => now);

    expect(api.sample).toBe(true);
    expect((await api.account()).id).toBe('acc_sample');
    expect((await api.keys()).map(key => key.label)).toEqual(['research-agent', 'ci-bot', 'old-laptop']);
    const services = await api.services();
    expect(services.map(service => service.id)).toEqual(['skycast-weather', 'geo-lookup']);
    for (const service of services) {
      const detail = await api.service(service.id);
      expect((await api.revisions(service.id)).some(revision => revision.active)).toBe(true);
      expect((await api.earnings(service.id)).serviceId).toBe(service.id);
      expect(await api.status(detail)).toMatchObject({ sample: true, value: { id: service.id, notices: [] } });
    }
    const first = await api.payments({ limit: 100 });
    expect(first.payments).toHaveLength(100);
    expect(first.next).toBe('100');
    const spend = summarizeSpend((await loadRecentPayments(api, now)).payments, now);
    expect(spend.window).toBeGreaterThan(0n);
  });

  it('creates, changes, and revokes keys and rolls back revisions in the tab, and refuses unknown ones with 404', async () => {
    const api = createSampleConsoleApi(() => now);

    const created = await api.createKey({ label: 'new-agent', dailyBudget: '3', maxPrice: '0.01' });
    expect(created.key).toMatch(/^sr_live_sample/);
    expect((await api.keys())[0]).toMatchObject({ id: created.id, label: 'new-agent', dailyBudget: '3', remaining: { dailyBudget: '3' } });

    await api.updateKey(created.id, { allowance: '10' });
    await api.revokeKey(created.id);
    expect((await api.keys())[0]).toMatchObject({ allowance: '10', revokedAt: now.toISOString() });

    await api.rollback('skycast-weather', 1);
    expect((await api.revisions('skycast-weather')).find(revision => revision.active)?.number).toBe(1);
    expect((await api.services())[0]!.revision).toBe(1);

    await expect(api.service('nope')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(api.revokeKey('key_nope')).rejects.toBeInstanceOf(ApiError);
  });
});
