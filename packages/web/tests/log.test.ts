import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCatalogService, listCatalog } from '../src/api/catalog';
import { logApiFailure } from '../src/api/failures';
import { ApiError, callApi } from '../src/api/http';
import { getTopup } from '../src/api/topup';
import { readSettings } from '../src/config';
import { createHttpConsoleApi } from '../src/console/api';
import { writeLogLine } from '../src/log';
import { logStartup } from '../src/startup';

// The website's server log (L-1, L-10, L-11): JSON lines on stdout, metadata only

const apiUrl = 'https://api.example.test';
const masterKey = 'srm_test_master_key_never_logged_0123456789';
const token = 'Rk3vQ9xT2mLpA7cZ0yBn4WsE8uHfJd6G';

const capture = () => {
  const lines: Record<string, unknown>[] = [];

  return { lines, write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) };
};

// The server's stdout, as Next.js runs it
const stdoutLines = () => {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    lines.push(JSON.parse(chunk) as Record<string, unknown>);

    return true;
  }) as typeof process.stdout.write);

  return lines;
};

const answering = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a failed Platform API read (L-10)', () => {
  it('logs one JSON line with the path without its query, the status, the error code, and the duration', async () => {
    const { lines, write } = capture();
    const failing = answering(500, { error: { code: 'internal_error', message: 'Internal server error' } });

    await expect(callApi(apiUrl, { path: '/v1/catalog?q=weather&cursor=query-secret', fetch: failing, onFailure: logApiFailure(undefined, { write, env: {} }) }))
      .rejects.toBeInstanceOf(ApiError);

    expect(lines).toEqual([{
      level: 40, time: expect.any(Number), name: 'web', path: '/v1/catalog', status: 500, code: 'internal_error', durationMs: expect.any(Number), msg: 'Reading the Platform API failed',
    }]);
    expect(JSON.stringify(lines)).not.toContain('query-secret');
  });

  it('logs an API that doesn\'t answer as api_unavailable with the transport\'s code, and a 404 not at all: it is an answer', async () => {
    const { lines, write } = capture();
    const refused = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), { code: 'ECONNREFUSED' }) });
    });

    await expect(callApi(apiUrl, { path: '/v1/catalog/weather', fetch: refused, onFailure: logApiFailure(undefined, { write, env: {} }) })).rejects.toMatchObject({ code: 'api_unavailable' });
    await expect(callApi(apiUrl, { path: '/v1/catalog/nothing', fetch: answering(404, { error: { code: 'not_found', message: 'Not found' } }), onFailure: logApiFailure(undefined, { write, env: {} }) }))
      .rejects.toMatchObject({ status: 404 });

    expect(lines).toEqual([expect.objectContaining({ level: 40, path: '/v1/catalog/weather', status: 503, code: 'api_unavailable', cause: 'ECONNREFUSED' })]);
  });

  it('logs the catalog\'s and the top-up page\'s reads on the server, naming the top-up route, never its token', async () => {
    const lines = stdoutLines();
    vi.stubGlobal('fetch', answering(503, { error: { code: 'upstream_unavailable', message: 'Unavailable' } }));
    const settings = readSettings({ API_URL: apiUrl, WEB_MOCKS: 'none' });

    await expect(listCatalog(settings, { sort: 'popular' })).rejects.toBeInstanceOf(ApiError);
    await expect(getCatalogService(settings, 'weather')).rejects.toBeInstanceOf(ApiError);
    await expect(getTopup(settings, token)).rejects.toBeInstanceOf(ApiError);

    expect(lines.map(line => [line['path'], line['status'], line['code']])).toEqual([
      ['/v1/catalog', 503, 'upstream_unavailable'],
      ['/v1/catalog/weather', 503, 'upstream_unavailable'],
      ['/v1/topup/{token}', 503, 'upstream_unavailable'],
    ]);
    expect(JSON.stringify(lines)).not.toContain(token);
  });

  it('logs nothing for the console, whose calls carry the master key from the browser', async () => {
    const lines = stdoutLines();
    const consoleApi = createHttpConsoleApi({ apiUrl, key: masterKey, fetch: answering(500, { error: { code: 'internal_error', message: 'Internal server error' } }) });

    await expect(consoleApi.account()).rejects.toBeInstanceOf(ApiError);
    await expect(consoleApi.keys()).rejects.toBeInstanceOf(ApiError);

    expect(lines).toEqual([]);
  });
});

describe('the website\'s log level and startup line (L-1, L-11)', () => {
  it('writes nothing below LOG_LEVEL, and nothing at silent', () => {
    const { lines, write } = capture();

    writeLogLine('warn', 'dropped', {}, { write, env: { LOG_LEVEL: 'error' } });
    writeLogLine('info', 'dropped', {}, { write, env: { LOG_LEVEL: 'silent' } });
    writeLogLine('error', 'kept', {}, { write, env: { LOG_LEVEL: 'ERROR' } });
    writeLogLine('debug', 'dropped', {}, { write, env: {} });

    expect(lines.map(line => line['msg'])).toEqual(['kept']);
  });

  it('logs one startup line with the commit, the URLs, and the groups served from sample data', () => {
    const { lines, write } = capture();

    logStartup({ write, env: { GIT_SHA: 'F7B6FFB', SITE_URL: 'https://site.test', API_URL: apiUrl, PAY_URL: 'https://pay.test', WEB_MOCKS: 'catalog,topup', LOG_LEVEL: 'debug' } });

    expect(lines).toEqual([expect.objectContaining({
      level: 30, name: 'web', app: 'web', commit: 'f7b6ffb', logLevel: 'debug', urls: { website: 'https://site.test', api: apiUrl, pay: 'https://pay.test' },
      sampleData: ['catalog', 'topup'], msg: 'Started',
    })]);
  });

  it('logs invalid settings with the variable\'s name, at error', () => {
    const { lines, write } = capture();

    logStartup({ write, env: { API_URL: 'not a url' } });

    expect(lines).toEqual([expect.objectContaining({ level: 50, msg: 'The website\'s settings are invalid', error: { type: 'InvalidSettingError', message: expect.stringContaining('API_URL') } })]);
  });
});
