#!/usr/bin/env node
// The credits overhead load test (PX-19): the proxy against the fake upstream, on a free path and paid
// with credits.
//
// 1. Overhead, the PX-19 check: both paths at one fixed request rate below capacity (an open loop),
//    and the p95 of each and the difference, which must stay under 50 ms.
// 2. Capacity, for sizing: each path with a fixed number of requests in flight (a closed loop), which
//    drives it to its limit. Its latency there is mostly queueing, so it gets no pass or fail.
//
// Usage (Postgres and Redis from `docker compose up -d`, TEST_DATABASE_URL and TEST_REDIS_URL in .env):
//   npm run loadtest
//
// Settings, from the environment:
//   LOADTEST_RATE         requests per second in the overhead check, default 300
//   LOADTEST_REQUESTS     requests per phase, default 3000
//   LOADTEST_CONCURRENCY  requests in flight in the capacity run, default 32
//   LOADTEST_BUYERS       buyers, each with a payment key, default 20
//   LOADTEST_SELLERS      sellers, each with a service, default 5
//   LOADTEST_FEE_BPS      the platform fee, default 250. At 0 no capture touches the fee row.
//
// The Platform API and the proxy run in the main thread, on a throwaway database and Redis prefix. The
// fake upstream and the load generator run in worker threads of their own, so they don't take the
// proxy's event loop. Every capture updates the one platform fee balance row, so the run also reports
// how long captures take to drain after the paid phase.

import { performance } from 'node:perf_hooks';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];
const ms = value => `${value.toFixed(1)} ms`;

const openapi = {
  openapi: '3.1.0',
  info: { title: 'Load', version: '1.0.0' },
  paths: {
    '/paid/{n}': { get: { operationId: 'getPaid', responses: { 200: { description: 'OK' } } } },
    '/free/{n}': { get: { operationId: 'getFree', responses: { 200: { description: 'OK' } } } },
  },
};

/** Worker: the fake upstream. Posts its port and CA. */
const upstreamThread = async () => {
  const { startFakeUpstream } = await import('@servicerouter/testing');
  const upstream = await startFakeUpstream({ hosts: ['api.example.com'] });
  const body = JSON.stringify({ temperature: 12.5, unit: 'C', city: 'Oslo' });
  upstream.handle((request, response) => {
    if (request.path === '/openapi.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(openapi));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(body);
  });
  parentPort.on('message', async () => {
    await upstream.close();
    process.exit(0);
  });
  parentPort.postMessage({ port: upstream.port, ca: upstream.ca });
};

/**
 * Worker: the load generator. Runs one phase per message and posts the latencies back. `rate` sends at
 * that many requests per second, each timed from when it was due, so a slow proxy can't hide its
 * queue (an open loop). Without it, `concurrency` requests stay in flight (a closed loop).
 */
const clientThread = () => {
  parentPort.on('message', async ({ total, concurrency, rate, urls, headers }) => {
    const latencies = [];
    const statuses = {};
    const started = performance.now();
    const send = async (index, due) => {
      const response = await fetch(urls[index % urls.length], { headers: headers[index % headers.length] });
      await response.arrayBuffer();
      latencies.push(performance.now() - due);
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
    };
    if (rate) {
      const sent = [];
      for (let index = 0; index < total; index++) {
        const due = started + index * 1_000 / rate;
        const wait = due - performance.now();
        if (wait > 0)
          await new Promise(resolve => setTimeout(resolve, wait));
        sent.push(send(index, due));
      }
      await Promise.all(sent);
    }
    else {
      let next = 0;
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next < total) {
          const index = next++;
          await send(index, performance.now());
        }
      }));
    }
    parentPort.postMessage({ latencies, seconds: (performance.now() - started) / 1_000, statuses });
  });
};

const main = async () => {
  const [{ createApp: createApi }, { createAddressPolicy, createLogger, OutboundHttp, Secret }, { loadPlatformConfig }, { createApp: createProxy }, testing] = await Promise.all([
    import('@servicerouter/api'),
    import('@servicerouter/common'),
    import('@servicerouter/core'),
    import('@servicerouter/proxy'),
    import('@servicerouter/testing'),
  ]);
  const settings = {
    rate: Number(process.env['LOADTEST_RATE'] ?? 300),
    requests: Number(process.env['LOADTEST_REQUESTS'] ?? 3_000),
    concurrency: Number(process.env['LOADTEST_CONCURRENCY'] ?? 32),
    buyers: Number(process.env['LOADTEST_BUYERS'] ?? 20),
    sellers: Number(process.env['LOADTEST_SELLERS'] ?? 5),
    feeBps: Number(process.env['LOADTEST_FEE_BPS'] ?? 250),
  };
  const warmup = 300;
  const limitMs = 50;
  const internalSecret = 'loadtest-internal-secret-0123456789abcdef';
  const generous = { requests: 10_000_000, windowSeconds: 60 };
  const logger = createLogger({ level: 'silent' });

  const upstreamWorker = new Worker(new URL(import.meta.url), { workerData: { role: 'upstream' } });
  const client = new Worker(new URL(import.meta.url), { workerData: { role: 'client' } });
  const nextMessage = worker => new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  const [database, redis, keys, upstream, config] = await Promise.all([
    testing.createTestDatabase(),
    testing.createTestRedis(),
    testing.createTestSecretKeys(),
    nextMessage(upstreamWorker),
    loadPlatformConfig({
      env: {
        CONFIG_PATH: 'config/example.yaml',
        CONFIG: Buffer.from(JSON.stringify({ feeBps: settings.feeBps, rateLimits: { signup: generous, paymentKey: generous, service: generous, unpaidIp: generous } })).toString('base64'),
      },
    }),
  ]);
  const upstreamUrl = path => `https://api.example.com:${upstream.port}${path}`;

  const resolver = testing.createFakeResolver({ 'api.example.com': '127.0.0.1' });
  const outbound = { ownHosts: config.ownHosts, resolver, addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }), ca: upstream.ca };
  const apiHttp = new OutboundHttp({ ...outbound, connectTimeoutMs: 5_000 });
  const proxyHttp = new OutboundHttp({
    ...outbound,
    connectTimeoutMs: config.timeouts.connectMs,
    totalTimeoutMs: config.timeouts.requestMs,
    maxRequestBytes: config.sizeLimits.requestBodyBytes,
    maxResponseBytes: config.sizeLimits.bufferedResponseBytes,
  });
  const api = createApi({ config, logger, postgres: database.postgres, redis, sealer: keys.sealer, openApiHttp: apiHttp, internalSecret: Secret.from(internalSecret) });
  const proxy = createProxy({
    config, logger, postgres: database.postgres, redis, opener: keys.opener, http: proxyHttp, buyerHeaderKey: Secret.from('loadtest-buyer-header-key-0123456789abcdef'),
  });
  const [apiPorts, proxyPorts] = await Promise.all([
    api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 }),
    proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 }),
  ]);
  const apiUrl = `http://127.0.0.1:${apiPorts.port}`;
  const internalUrl = `http://127.0.0.1:${apiPorts.internalPort}`;
  const proxyUrl = `http://127.0.0.1:${proxyPorts.port}`;

  try {
    await proxy.subscribed;
    const json = async (url, init) => {
      const response = await fetch(url, init);
      const answer = await response.json();
      if (!response.ok)
        throw new Error(`${init?.method ?? 'GET'} ${url} answered ${response.status}: ${JSON.stringify(answer)}`);

      return answer;
    };
    const signup = () => json(`${apiUrl}/v1/accounts`, { method: 'POST' });
    const asAccount = (account, method, path, payload) => json(`${apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${account.masterKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const serviceYaml = id => `servicerouter:
  version: "1"
service:
  id: ${id}
  title: Load
  description: Load test service.
  category: weather
payouts:
  default:
    asset: cardano-usdm
    address: addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5
payments:
  default:
    amount: "0.001"
upstreams:
  - baseUrl: ${upstreamUrl('/v1')}
    openapi: ${upstreamUrl('/openapi.json')}
    auth: main-key
routes:
  getFree:
    payment:
      amount: "0"
credentials:
  main-key:
    type: http
    scheme: bearer
    secret: main-key
`;

    const services = await Promise.all(Array.from({ length: settings.sellers }, async (_, index) => {
      const seller = await signup();
      const id = `load-${index + 1}`;
      await asAccount(seller, 'PUT', `/v1/services/${id}`, { config: serviceYaml(id), secrets: { 'main-key': `sk-load-${index}` } });

      return id;
    }));
    const buyers = await Promise.all(Array.from({ length: settings.buyers }, async (_, index) => {
      const buyer = await signup();
      const { key } = await asAccount(buyer, 'POST', '/v1/keys', { dailyBudget: '100000' });
      await json(`${internalUrl}/internal/v1/accounts/${buyer.id}/credits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': internalSecret },
        body: JSON.stringify({ amount: '100000', reference: `load-${index}` }),
      });

      return { ...buyer, key };
    }));

    // Every buyer calls every service: the paths cycle by service, the keys by buyer
    const phase = async (total, kind, { rate } = {}) => {
      const loop = performance.eventLoopUtilization();
      client.postMessage({
        total,
        concurrency: settings.concurrency,
        rate,
        urls: services.map(id => `${proxyUrl}/service/${id}/${kind}/1`),
        headers: kind === 'paid' ? buyers.map(buyer => ({ authorization: `Bearer ${buyer.key}` })) : [{}],
      });
      const result = await nextMessage(client);
      // How busy the proxy's event loop was: near 1 means the proxy, not Postgres, sets the pace
      const busy = performance.eventLoopUtilization(loop).utilization;

      return { ...result, busy, latencies: result.latencies.sort((left, right) => left - right) };
    };
    const summary = (name, { latencies, seconds, statuses, busy }) => {
      console.log(`${name.padEnd(6)} p50 ${ms(percentile(latencies, 50))}, p95 ${ms(percentile(latencies, 95))}, p99 ${ms(percentile(latencies, 99))}, `
        + `${Math.round(latencies.length / seconds)} req/s, proxy event loop ${Math.round(busy * 100)}% busy, statuses ${JSON.stringify(statuses)}`);

      return percentile(latencies, 95);
    };

    console.log(`Proxy credits load test (PX-19): ${settings.buyers} buyers, ${settings.sellers} sellers, fee ${settings.feeBps} bps, `
      + `${settings.requests} requests per phase after ${warmup} warmup requests`);
    await phase(warmup, 'free');
    await phase(warmup, 'paid');

    console.log(`Overhead at ${settings.rate} requests/s (open loop):`);
    const freeP95 = summary('free', await phase(settings.requests, 'free', { rate: settings.rate }));
    const paidP95 = summary('paid', await phase(settings.requests, 'paid', { rate: settings.rate }));
    const overhead = paidP95 - freeP95;
    console.log(`p95 difference ${ms(overhead)} (limit ${limitMs} ms): ${overhead < limitMs ? 'PASS' : 'FAIL'}`);

    console.log(`Capacity with ${settings.concurrency} in flight (closed loop; latency here is mostly queueing):`);
    summary('free', await phase(settings.requests, 'free'));
    const paidStart = performance.now();
    summary('paid', await phase(settings.requests, 'paid'));

    // Captures run after each response: wait until nothing is held, and time the tail
    const afterPaid = performance.now();
    const held = async () => (await Promise.all(buyers.map(buyer => asAccount(buyer, 'GET', '/v1/balance')))).filter(balance => balance.held !== '0').length;
    while (await held() > 0)
      await new Promise(resolve => setTimeout(resolve, 20));
    const drainMs = performance.now() - afterPaid;
    const fees = await database.db.execute(`select balance::text as balance from balances where ledger_account_id = 'platform:fees'`);
    const captured = await database.db.execute(`select count(*)::int as count from payments where status = 'captured'`);
    const expected = 2 * settings.requests + warmup;
    console.log(`captures drained ${ms(drainMs)} after the capacity run's paid phase (${ms(afterPaid - paidStart)} long); `
      + `${captured.rows[0].count} of ${expected} payments captured; platform fees ${fees.rows[0]?.balance ?? 0} micro-USD at ${settings.feeBps} bps`);

    process.exitCode = overhead < limitMs && captured.rows[0].count === expected ? 0 : 1;
  }
  finally {
    upstreamWorker.postMessage('close');
    await client.terminate();
    await Promise.all([api.close(), proxy.close()]);
    await Promise.all([apiHttp.close(), proxyHttp.close()]);
    await Promise.all([database.drop(), redis.cleanup()]);
  }
};

if (isMainThread)
  await main();
else if (workerData.role === 'upstream')
  await upstreamThread();
else
  clientThread();
