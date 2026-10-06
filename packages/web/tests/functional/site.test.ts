import { fixtureTime } from '@servicerouter/testing';

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CatalogItem, CatalogService, Topup } from '../../src/api/types';
import { logoPaths } from '../../src/logo';
import { sampleTopup } from '../../src/mocks/topup';

// The website from a production build (`next build`, then `next start`), as the image runs it. One server
// shows every group as sample data (WB-10); another reads the catalog from a fake Platform API (WB-2).

const webRoot = fileURLToPath(new URL('../..', import.meta.url));
const nextBin = fileURLToPath(new URL('../../../../node_modules/next/dist/bin/next', import.meta.url));
// Its own build directory, so a developer's .next stays as it is
const distDir = '.next-functional';
const site = 'https://servicerouter.test';
const pay = 'https://pay.servicerouter.test';

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise(resolve => server.close(resolve));

  return port;
};

interface Running {
  readonly url: string;
  readonly process: ChildProcess;
  // The JSON lines the server wrote to stdout (L-1, L-10). Next.js's own text lines are left out.
  readonly logs: Record<string, unknown>[];
}

const startSite = async (env: Record<string, string>): Promise<Running> => {
  const port = await freePort();
  const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: webRoot,
    env: { ...process.env, NODE_ENV: 'production', NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: '1', SITE_URL: site, PAY_URL: pay, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const logs: Record<string, unknown>[] = [];
  let pending = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    const parts = `${pending}${chunk}`.split('\n');
    pending = parts.pop()!;
    for (const part of parts.filter(text => text.startsWith('{'))) {
      try {
        logs.push(JSON.parse(part) as Record<string, unknown>);
      }
      catch {
        // Not one of ours
      }
    }
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${url}/_/health`)).ok)
        return { url, process: child, logs };
    }
    catch {
      // Not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error('The website didn\'t start');
};

// --- A fake Platform API with one service, for the real catalog path ---

const realService: CatalogService = {
  id: 'real-weather', title: 'Real Weather', summary: 'From the Platform API', category: 'weather', tags: ['weather'], priceFrom: '0.002', currency: 'USD',
  methods: ['credits', 'x402'], stats: { calls30d: 42, successRate: 0.95, p50Ms: 100, p95Ms: 300 }, verified: true, updatedAt: fixtureTime(0, 6, 10, 0, 0, 0),
  description: 'A service the fake Platform API lists.', links: { homepage: 'https://real.example.com' }, contact: {},
  routes: [{ key: 'getNow', method: 'GET', path: '/now/{city}', summary: 'Now', price: '0.002', methods: ['credits', 'x402'], stats: { calls30d: 42, successRate: 0.95, p50Ms: 100, p95Ms: 300 } }],
  docs: { openapi: 'unused', llms: 'unused', skill: 'unused' }, payUrl: `${pay}/service/real-weather`,
};
const { description: _description, links: _links, contact: _contact, routes: _routes, docs: _docs, payUrl: _payUrl, ...realItem } = realService;
// A routed endpoint, as GET /v1/catalog lists it after the registered services (CI-2)
const routedItem: CatalogItem = {
  id: 'routed:api.paid.example/v1/data', title: 'api.paid.example/v1/data', summary: 'A paid API that Service Router routes payments to. Unverified: its owner hasn\'t registered it.',
  category: '', tags: [], priceFrom: '0.01', currency: 'USD', methods: ['credits', 'x402', 'mpp'], stats: { calls30d: 0, successRate: 0, p50Ms: 0, p95Ms: 0 },
  verified: false, updatedAt: fixtureTime(0, 6, 10, 0, 0, 0), link: `${pay}/api.paid.example/v1/data`,
};
// A buyer's real top-up link, as the API issues it: 32 base64url characters
const realToken = 'Rk3vQ9xT2mLpA7cZ0yBn4WsE8uHfJd6G';
// One whose read fails
const brokenToken = 'Zq8wE2rT6yU0iO4pA9sD3fG7hJ1kL5xC';
const realTopup: Topup = {
  address: 'addr1q9realbuyeraddressfromtheplatformapi0000000000000000000000000000000000000',
  asset: { name: 'cardano-usdm', symbol: 'USDM', network: 'cardano:mainnet', networkTitle: 'Cardano' },
  confirmationsRequired: 15,
  deposits: [],
};
const apiRequests: string[] = [];
const fakeApi: Server = createServer((request, response) => {
  apiRequests.push(request.url ?? '');
  const path = (request.url ?? '').split('?')[0];
  const json = (status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (path === '/v1/catalog')
    json(200, { services: [realItem satisfies CatalogItem, routedItem], categories: [{ id: 'weather', title: 'Weather', count: 1 }], next: null });
  else if (path === '/v1/catalog/real-weather')
    json(200, realService);
  else if (path === `/v1/topup/${realToken}`)
    json(200, realTopup);
  // A Platform API that fails, for the server's log (L-10)
  else if (path === '/v1/catalog/broken-service' || path === `/v1/topup/${brokenToken}`)
    json(500, { error: { code: 'internal_error', message: 'Internal server error' } });
  else
    json(404, { error: { code: 'not_found', message: 'Not found' } });
});

let sampled: Running;
let real: Running;

beforeAll(async () => {
  const build = spawnSync(process.execPath, [nextBin, 'build'], {
    cwd: webRoot,
    env: { ...process.env, NODE_ENV: 'production', NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
  });
  if (build.status !== 0)
    throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`);

  await new Promise<void>(resolve => fakeApi.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${(fakeApi.address() as AddressInfo).port}`;
  [sampled, real] = await Promise.all([
    // The API is never called while everything is sample data
    startSite({ API_URL: 'http://127.0.0.1:9', WEB_MOCKS: 'catalog,agent-docs,topup' }),
    startSite({ API_URL: apiUrl, WEB_MOCKS: 'agent-docs,topup', GIT_SHA: 'f7b6ffb' }),
  ]);
}, 300_000);

afterAll(async () => {
  sampled?.process.kill();
  real?.process.kill();
  await new Promise(resolve => fakeApi.close(resolve));
});

const page = async (path: string, init?: RequestInit, at: Running = sampled) => {
  const response = await fetch(`${at.url}${path}`, init);

  return { response, body: await response.text() };
};

// The services a listing shows, in order
const listed = (html: string): readonly string[] => [...html.matchAll(/data-service="([^"]+)"/g)].map(match => match[1]!);

describe('every page renders from a production build, with sample data labeled (WB-1, WB-10, step 15)', () => {
  it.each([
    ['/', 'Pay-per-call APIs for every agent'],
    ['/discover', 'Discover services'],
    ['/discover/chain-rpc', 'Chain RPC Gateway'],
    ['/topup/demo-token', 'Top up your credits'],
    ['/agents', 'Service Router for agents'],
  ])('%s', async (path, heading) => {
    const { response, body } = await page(path);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain(heading);
    expect(body).toContain(logoPaths[0]!.slice(0, 40));
    if (path !== '/agents')
      expect(body).toContain('data-sample="true"');
  });

  it('answers 404 for a service the catalog doesn\'t list, and 200 for /_/health', async () => {
    expect((await page('/discover/no-such-service')).response.status).toBe(404);
    expect(await (await fetch(`${sampled.url}/_/health`)).json()).toEqual({ status: 'ok' });
  });
});

describe('/discover filters by category, text, payment method, and price, and sorts (CI-5, WB-1)', () => {
  it('filters a category with its subcategories, and shows each category\'s count', async () => {
    const { body } = await page('/discover?category=finance');

    expect([...listed(body)].sort()).toEqual(['crypto-prices', 'fx-rates', 'ticker-quotes']);
    expect(body).toMatch(/Market data<\/span><span class="count num">2</);
  });

  it.each([
    ['?q=weather', ['skycast-weather']],
    ['?maxPrice=0.0001', ['crypto-prices']],
    ['?category=ai&method=x402&sort=price', ['lingua-translate', 'voice-scribe', 'pixel-forge']],
  ])('lists %s', async (query, expected) => {
    expect(listed((await page(`/discover${query}`)).body)).toEqual(expected);
  });

  it('sorts by calls over 30 days by default', async () => {
    expect(listed((await page('/discover')).body).slice(0, 3)).toEqual(['chain-rpc', 'crypto-prices', 'ticker-quotes']);
  });
});

describe('a service page (WB-1, WB-11, AD-1, AD-2)', () => {
  it('shows the routes with prices and payment methods, the stats, the agent documents, the prompt, and JSON-LD', async () => {
    const { body } = await page('/discover/skycast-weather');

    expect(body).toContain('GET /current/{city}');
    expect(body).toContain('$0.001');
    expect(body).toContain(`href="${site}/discover/skycast-weather/openapi.json"`);
    expect(body).toContain(`Read ${site}/discover/skycast-weather/llms.txt`);
    expect(body).toMatch(/<script type="application\/ld\+json" nonce="[^"]+">\{"@context":"https:\/\/schema.org","@type":"WebAPI"/);
  });

  it('serves the agent documents while they are sample data: the pay URL as the server, and the price of each operation', async () => {
    const openapi = await (await fetch(`${sampled.url}/discover/skycast-weather/openapi.json`)).json() as { servers: { url: string }[]; paths: Record<string, Record<string, Record<string, unknown>>> };
    const llms = await page('/discover/skycast-weather/llms.txt');
    const skill = await page('/discover/skycast-weather/skill.md');

    expect(openapi.servers).toEqual([{ url: `${pay}/service/skycast-weather` }]);
    expect(openapi.paths['/forecast/{city}']!['get']!['x-payment-info']).toEqual({ price: '0.002', currency: 'USD', methods: ['credits', 'x402', 'mpp'] });
    expect(llms.response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(llms.body).toMatch(/^# Skycast Weather/);
    expect(skill.body).toMatch(/^---\nname: skycast-weather\n/);
  });
});

describe('for agents (WB-11)', () => {
  it('serves the guide, everything in one file, and both skills', async () => {
    const guide = await page('/llms.txt');
    const full = await page('/llms-full.txt');
    const buyer = await page('/skills/servicerouter-buyer/SKILL.md');
    const seller = await page('/skills/servicerouter-seller/SKILL.md');

    expect(guide.body).toMatch(/^# Service Router\n\n> /);
    expect(guide.body).toContain(`${site}/skills/servicerouter-buyer/SKILL.md`);
    expect(full.body).toContain('name: servicerouter-seller');
    expect(full.body).toContain(`${site}/discover/pixel-forge.md`);
    expect(buyer.response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(buyer.body).toMatch(/^---\nname: servicerouter-buyer\n/);
    expect(seller.body).toMatch(/^---\nname: servicerouter-seller\n/);
    expect((await page('/skills/nope/SKILL.md')).response.status).toBe(404);
  });

  it.each([
    ['/', '/index.md', '# Service Router: Pay-per-call APIs for every agent'],
    ['/discover?category=weather', '/discover.md?category=weather', '[Skycast Weather]'],
    ['/discover/chain-rpc', '/discover/chain-rpc.md', '# Chain RPC Gateway'],
    ['/agents', '/agents.md', '# Service Router for agents'],
    ['/topup/demo-token', '/topup/demo-token.md', '# Top up your credits'],
  ])('gives %s in Markdown, at %s and with Accept: text/markdown', async (path, markdownPath, text) => {
    const html = await page(path);
    const byUrl = await page(markdownPath);
    const byAccept = await page(path, { headers: { accept: 'text/markdown' } });

    expect(html.body).toContain(`<link rel="alternate" type="text/markdown" href="${site}${markdownPath.split('?')[0]}`);
    for (const markdown of [byUrl, byAccept]) {
      expect(markdown.response.status).toBe(200);
      expect(markdown.response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(markdown.body).toContain(text);
    }
  });

  it('lets every crawler read the public pages but not the console, and lists every service in the sitemap', async () => {
    const robots = (await page('/robots.txt')).body;
    const sitemap = (await page('/sitemap.xml')).body;

    expect(robots).toContain('User-Agent: *');
    expect(robots).toContain('Disallow: /console');
    expect(robots).toContain(`Sitemap: ${site}/sitemap.xml`);
    expect(sitemap).toContain(`<loc>${site}/discover/chain-rpc</loc>`);
    expect(sitemap.match(/<loc>/g)).toHaveLength(4 + 13);
  });
});

describe('the console (WB-8, WB-10)', () => {
  it.each(['/console', '/console/overview', '/console/keys', '/console/payments', '/console/services', '/console/services/skycast-weather', '/console/topup', '/console/account'])(
    '%s renders in the browser, noindex, with the Platform API as the only place to connect to',
    async path => {
      const { response, body } = await page(path);

      expect(response.status).toBe(200);
      expect(body).toContain('<meta name="robots" content="noindex, nofollow"/>');
      expect(response.headers.get('content-security-policy')).toContain('connect-src \'self\' http://127.0.0.1:9;');
      expect(response.headers.get('set-cookie')).toBeNull();
    },
  );
});

describe('security headers (WB-12)', () => {
  it('sends a CSP whose fresh nonce every script on the page carries, with only the Platform API to connect to', async () => {
    const first = await page('/discover/chain-rpc');
    const second = await page('/discover/chain-rpc');
    const policy = first.response.headers.get('content-security-policy')!;
    const nonce = /'nonce-([^']+)'/.exec(policy)![1]!;
    const scripts = [...first.body.matchAll(/<script\b[^>]*>/g)].map(match => match[0]);

    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every(script => script.includes(`nonce="${nonce}"`))).toBe(true);
    expect(second.response.headers.get('content-security-policy')).not.toContain(nonce);
    expect(policy).toContain('connect-src \'self\' http://127.0.0.1:9;');
    expect(policy).toContain('frame-ancestors \'none\'');
    expect(scripts.some(script => /src="https?:/.test(script))).toBe(false);
    expect(first.response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(first.response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('the logo and icons (WB-9)', () => {
  it('draws the favicon, the app icon, and the social image from the logo\'s paths', async () => {
    const svg = await page('/logo.svg');
    const png = async (path: string) => Buffer.from(await (await fetch(`${sampled.url}${path}`)).arrayBuffer()).subarray(1, 4).toString('latin1');

    expect(svg.response.headers.get('content-type')).toBe('image/svg+xml');
    for (const path of logoPaths)
      expect(svg.body).toContain(path);
    expect(await png('/icon')).toBe('PNG');
    expect(await png('/apple-icon')).toBe('PNG');
    expect(await png('/opengraph-image')).toBe('PNG');
  });
});

describe('the top-up page (WB-3)', () => {
  it('shows the address, its asset and network, a QR code of it, and the deposits', async () => {
    const { body } = await page('/topup/demo-token');
    const { address } = sampleTopup('demo-token');

    expect(body).toContain(address);
    expect(body).toContain(`data-qr="${address}"`);
    expect(body).toMatch(/<div class="qr"[^>]*><svg/);
    expect(body).toContain('USDM');
    expect(body).toContain('Never send funds to it');
    expect(body).toContain('3<!-- -->/<!-- -->15');
    expect(body).toContain('Not credited');
  });

  it('shows a buyer\'s real link from the Platform API even while top-up samples are on, never the sample address (DP-5, WB-10, T15 round 1)', async () => {
    const { response, body } = await page(`/topup/${realToken}`, undefined, real);
    const markdown = await page(`/topup/${realToken}.md`, undefined, real);
    const unknown = await page('/topup/Zz9ZZzz9ZZzz9ZZzz9ZZzz9ZZzz9ZZzz', undefined, real);

    expect(response.status).toBe(200);
    expect(body).toContain(realTopup.address);
    expect(body).not.toContain(sampleTopup('x').address);
    expect(body).not.toContain('data-sample="true"');
    expect(markdown.body).toContain(realTopup.address);
    expect(apiRequests).toContain(`/v1/topup/${realToken}`);
    expect(unknown.response.status).toBe(404);
    expect(unknown.body).not.toContain(sampleTopup('x').address);
  });
});

describe('with the Platform API\'s catalog (WB-2, WB-10, CI-5)', () => {
  it('lists what the API answers, unlabeled, passing the page\'s query on', async () => {
    const { body } = await page('/discover?category=weather&sort=price', undefined, real);

    expect(listed(body)).toEqual(['real-weather', routedItem.id]);
    expect(body).not.toContain('data-sample="true"');
    expect(apiRequests).toContain('/v1/catalog?category=weather&sort=price&limit=24');
  });

  it('shows a service from GET /v1/catalog/{id}, and 404 for one the API doesn\'t know', async () => {
    const found = await page('/discover/real-weather', undefined, real);

    expect(found.response.status).toBe(200);
    expect(found.body).toContain('Real Weather');
    expect(found.body).not.toContain('data-sample="true"');
    expect((await page('/discover/skycast-weather', undefined, real)).response.status).toBe(404);
  });

  it('labels a routed endpoint Unverified and links its routing link, with no page or sitemap entry of its own (CI-2, AR14)', async () => {
    const { body } = await page('/discover', undefined, real);
    const sitemap = (await page('/sitemap.xml', undefined, real)).body;
    const markdown = (await page('/discover.md', undefined, real)).body;

    expect(body).toContain(`<a href="${routedItem.link}" class="card card-link service-card" data-service="${routedItem.id}" rel="nofollow"><span class="label">Unverified</span>`);
    expect(sitemap).toContain(`<loc>${site}/discover/real-weather</loc>`);
    expect(sitemap).not.toContain('routed:');
    expect(markdown).toContain(`[${routedItem.title}](${routedItem.link}) (unverified)`);
  });
});

describe('the website\'s server log (L-1, L-10)', () => {
  it('logs one startup line with the commit, the API it reads, and the groups served from sample data', () => {
    expect(real.logs.filter(line => line['msg'] === 'Started')).toEqual([expect.objectContaining({
      level: 30, name: 'web', app: 'web', commit: 'f7b6ffb', urls: { website: site, api: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), pay }, sampleData: ['agent-docs', 'topup'],
    })]);
  });

  it('logs a failed Platform API read with the path without its query, the status, and the code, and never a top-up token', async () => {
    await page('/discover/broken-service?utm=query-secret', undefined, real);
    await page(`/topup/${brokenToken}`, undefined, real);

    await expect.poll(() => real.logs.filter(line => line['msg'] === 'Reading the Platform API failed').length).toBeGreaterThanOrEqual(2);
    expect(real.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 40, name: 'web', path: '/v1/catalog/broken-service', status: 500, code: 'internal_error', durationMs: expect.any(Number) }),
      expect.objectContaining({ level: 40, path: '/v1/topup/{token}', status: 500, code: 'internal_error' }),
    ]));
    expect(JSON.stringify(real.logs)).not.toMatch(new RegExp(`query-secret|${brokenToken}|${realToken}`));
  });
});
