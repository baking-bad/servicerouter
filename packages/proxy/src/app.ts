import type { FastifyInstance } from 'fastify';

import {
  createServer, OutboundHttp, randomIdGenerator, ServiceRouterError, systemClock, type Clock, type IdGenerator, type Logger, type Secret,
  type Server,
} from '@servicerouter/common';
import { RateLimitedError, type InvalidationBus, type PlatformConfig, type RateLimiter, type SecretOpener } from '@servicerouter/core';
import {
  createKeyStore, createLedger, createPaymentRepository, createRedisInvalidationBus, createRedisRateLimiter, createServiceRepository,
  type Postgres, type Redis,
} from '@servicerouter/db';
import {
  createCreditsRail, createMppRail, createX402Rail, detectMpp, detectX402, type MppSetup, type PaymentRail, type X402Setup,
} from '@servicerouter/payments';

import { errorStatuses } from './errors.js';
import { createProxyMetrics } from './metrics.js';
import { createBuyerHeaderValue } from './payments/buyer.js';
import { createKeyCache, type KeyCacheSettings } from './payments/keyCache.js';
import { createProxyLimits } from './payments/limits.js';
import { createPaymentStep } from './payments/step.js';
import { registerKeyRoute } from './platform/key.js';
import { createRuntimeCache } from './services/cache.js';
import { createServiceLoader, disposeService, type ServiceLoad } from './services/loader.js';
import { proxiedMethods, registerProxyRoutes } from './services/routes.js';

// Runtime cache defaults (PX-3): invalidation keeps entries fresh, the TTL is the safety net
export const runtimeCacheDefaults = {
  maxServices: 1_000,
  ttlMs: 5 * 60_000,
  // Unknown and unavailable services, so random IDs don't reach Postgres
  noneTtlMs: 10_000,
} as const;

export interface RuntimeCacheSettings {
  readonly maxServices: number;
  readonly ttlMs: number;
  readonly noneTtlMs: number;
}

// Payment key cache defaults (PR-4, AK-9): key events keep entries fresh, the TTL is the safety net
export const keyCacheDefaults = {
  maxKeys: 10_000,
  ttlMs: 60_000,
  // Unknown hashes, so random keys don't reach Postgres
  missTtlMs: 10_000,
} as const satisfies KeyCacheSettings;

export interface ProxyDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly postgres: Postgres;
  readonly redis: Redis;
  // Request IDs for requests without one. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
  // Opens seller secrets with the proxy's private keys (SC-4). See `readSecretsOpener`.
  readonly opener: SecretOpener;
  // Calls upstreams. Default: Outbound HTTP with the production address policy, the platform's own
  // hosts refused, and the limits from platform config (PX-8). Closed with the app.
  readonly http?: Pick<OutboundHttp, 'request'>;
  // Where runtime changes are announced (SR-7). Default: the Redis channel, closed with the app.
  readonly invalidation?: InvalidationBus;
  // Milliseconds since the epoch, for the caches' TTLs. Default: Date.now.
  readonly now?: () => number;
  readonly runtimeCache?: Partial<RuntimeCacheSettings>;
  readonly keyCache?: Partial<KeyCacheSettings>;
  // BUYER_HEADER_KEY, the buyer header's HMAC key (PX-15). See `readBuyerHeaderKey`.
  readonly buyerHeaderKey: Secret;
  // Payment and ledger times, key expiry, and the UTC day (CK-5). Default: the system clock.
  readonly clock?: Clock;
  // Payment and ledger IDs. Default: random UUIDs.
  readonly ids?: IdGenerator;
  // PX-13. Default: fixed windows in Redis.
  readonly rateLimiter?: RateLimiter;
  // The proxies in front, such as Traefik, whose X-Forwarded-For gives the client IP for the unpaid limit
  readonly trustProxy?: string;
  // x402 on Base and Solana (PR-5), from `initializeX402`. Without it, an x402 payment gets the 402.
  readonly x402?: X402Setup;
  // MPP on Tempo (PR-9), from `initializeMpp`. Without it, an MPP credential gets the 402.
  readonly mpp?: MppSetup;
}

export interface ProxyServer extends Server {
  // Resolves once the runtime cache receives invalidation events. The proxy serves before that.
  readonly subscribed: Promise<void>;
}

// PX-9: a seller's HTML must never run as the pay origin, which also serves the link checker
const securityHeaders = {
  'content-security-policy': 'sandbox',
  'x-content-type-options': 'nosniff',
} as const;

// PX-16. The credits receipt header is Servicerouter-Receipt (AR2).
const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, WWW-Authenticate, Payment-Receipt, Servicerouter-Receipt, x-request-id',
} as const;
const preflightHeaders = {
  'access-control-allow-methods': proxiedMethods.join(', '),
  'access-control-allow-headers': 'Authorization, PAYMENT-SIGNATURE, X-PAYMENT, Content-Type',
  'access-control-max-age': '600',
} as const;

// A 401 names the scheme it expects
const keyErrorCodes = new Set(['unauthorized', 'invalid_key', 'wrong_key_type']);

const registerResponseHeaders = (app: FastifyInstance): void => {
  // A CORS preflight is answered here, before any route: it never reaches an upstream
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS' && request.headers.origin !== undefined && request.headers['access-control-request-method'] !== undefined)
      return reply.status(204).headers(preflightHeaders).send();

    return undefined;
  });
  // Headers that belong to an error: Retry-After on 429 (PX-13), the scheme on 401
  app.addHook('onError', async (_request, reply, error) => {
    if (error instanceof RateLimitedError)
      reply.header('retry-after', String(error.retryAfterSeconds));
    else if (error instanceof ServiceRouterError && keyErrorCodes.has(error.code))
      reply.header('www-authenticate', 'Bearer');
  });
  // Every response, proxied or not, including errors. A 402 is never cached (PR-2).
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.headers({ ...securityHeaders, ...corsHeaders });
    if (reply.statusCode === 402)
      reply.header('cache-control', 'no-store');

    return payload;
  });
};

/**
 * The proxy on pay.servicerouter.ai (PX-1 to PX-16). Readiness covers Postgres and Redis.
 * Facilitators join it with x402 (PX-17), and the Tempo RPC with MPP.
 */
export const createApp = ({
  config,
  logger,
  postgres,
  redis,
  requestIds,
  opener,
  http,
  invalidation,
  now,
  runtimeCache = {},
  keyCache: keyCacheSettings = {},
  buyerHeaderKey,
  clock = systemClock,
  ids = randomIdGenerator,
  rateLimiter = createRedisRateLimiter({ redis }),
  trustProxy,
  x402,
  mpp,
}: ProxyDependencies): ProxyServer => {
  const server = createServer({
    logger,
    errorStatuses,
    requestIds,
    trustProxy,
    bodyLimit: config.sizeLimits.requestBodyBytes,
    readinessChecks: [
      { name: 'postgres', check: () => postgres.ping() },
      { name: 'redis', check: () => redis.ping() },
      // PX-17: every enabled facilitator answers /supported
      ...(x402?.facilitators ?? []).map(facilitator => ({
        name: `facilitator:${facilitator.name}`,
        check: async () => {
          await facilitator.getSupported();
        },
      })),
      // PR-9: the Tempo RPC answers with mpp.network's chain ID
      ...(mpp ? [{ name: 'mpp', check: () => mpp.check(config.timeouts.connectMs) }] : []),
    ],
  });
  const { app } = server;
  const metrics = createProxyMetrics(server.metrics.registry);
  registerResponseHeaders(app);

  let upstreams = http;
  if (!upstreams) {
    const outbound = new OutboundHttp({
      ownHosts: config.ownHosts,
      connectTimeoutMs: config.timeouts.connectMs,
      totalTimeoutMs: config.timeouts.requestMs,
      maxRequestBytes: config.sizeLimits.requestBodyBytes,
      // A streamed response is cut off past this, the same limit as a buffered one (AR3)
      maxResponseBytes: config.sizeLimits.bufferedResponseBytes,
    });
    app.addHook('onClose', async () => outbound.close());
    upstreams = outbound;
  }

  const settings = { ...runtimeCacheDefaults, ...runtimeCache };
  const cache = createRuntimeCache<ServiceLoad>({
    load: createServiceLoader({ services: createServiceRepository({ db: postgres.db }), opener, platform: config, logger }),
    dispose: disposeService,
    now,
    maxEntries: settings.maxServices,
    ttlMs: settings.ttlMs,
    noneTtlMs: settings.noneTtlMs,
    onLookup: result => metrics.cacheLookup(result),
  });

  // Payments (PR-1 to PR-4, PR-10): the credits rail, with keys from a short cache (AK-9)
  const keys = createKeyCache({
    ...keyCacheDefaults,
    ...keyCacheSettings,
    store: createKeyStore({ db: postgres.db }),
    now,
    onLookup: result => metrics.keyCacheLookup(result),
  });
  const ledger = createLedger({ db: postgres.db, clock, ids });
  const credits = createCreditsRail({
    keys,
    ledger,
    clock,
    keyPrefixes: config.keyPrefixes,
    signupUrl: `${config.urls.api.replace(/\/+$/, '')}/v1/accounts`,
    guideUrl: `${config.urls.website.replace(/\/+$/, '')}/llms.txt`,
  });
  const limits = createProxyLimits({ limiter: rateLimiter, limits: config.rateLimits, logger, metrics });
  const recorder = createPaymentRepository({ db: postgres.db, clock });
  const x402Rail = x402 ? createX402Rail({ setup: x402, recorder, ledger, logger }) : undefined;
  const mppRail = mpp ? createMppRail({ setup: mpp, recorder, ledger, logger, clock, settleTimeoutMs: config.timeouts.settleMs }) : undefined;
  const rails: PaymentRail[] = [credits, ...(x402Rail ? [x402Rail] : []), ...(mppRail ? [mppRail] : [])];
  const payments = createPaymentStep({
    rails,
    // A rail that is off is still detected, so two credentials of any kind get 400 (PR-1)
    detectors: [credits.detect, x402Rail?.detect ?? detectX402, mppRail?.detect ?? detectMpp],
    recorder,
    limits,
    buyerHeaderValue: createBuyerHeaderValue(buyerHeaderKey),
    ids,
    feeBps: config.feeBps,
    payUrl: config.urls.pay,
    logger,
    metrics,
  });
  registerKeyRoute(app, { credits, limits, ledger, clock });
  registerProxyRoutes(app, { cache, http: upstreams, payUrl: config.urls.pay, metrics, payments });
  // Shutdown finishes or releases the holds of the last responses (PX-18)
  app.addHook('onClose', async () => payments.drain());

  // Invalidation (SR-7, SC-7, AK-9): drop a service or a key when it changes, and everything after a
  // missed stretch
  const ownedBus = invalidation ? undefined : createRedisInvalidationBus({ redis, logger });
  const bus = invalidation ?? ownedBus!;
  const subscription = bus.subscribe(event => {
    metrics.invalidation(event.kind);
    if (event.kind === 'service')
      cache.invalidate(event.id);
    else if (event.kind === 'key')
      keys.invalidate(event.id);
  }, {
    onReconnect: () => {
      metrics.reconnect();
      cache.clear();
      keys.clear();
    },
  });
  let closing = false;
  // Without a subscription the cache still expires on its own, so the proxy serves meanwhile
  const subscribed = subscription.then(() => undefined, (error: unknown) => {
    // Closing ends a subscription that is still connecting; that is no failure
    if (!closing)
      logger.error({ error }, 'The runtime cache couldn\'t subscribe to invalidation events');
  });
  app.addHook('onClose', async () => {
    closing = true;
    // A subscription still connecting is dropped whenever it completes: closing never waits for Redis
    void subscription.then(unsubscribe => unsubscribe(), () => undefined);
    await ownedBus?.close();
    cache.clear();
    keys.clear();
  });

  return { ...server, subscribed };
};
