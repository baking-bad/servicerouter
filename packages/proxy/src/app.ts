import type { FastifyInstance } from 'fastify';

import { createServer, OutboundHttp, type IdGenerator, type Logger, type Server } from '@servicerouter/common';
import type { InvalidationBus, PlatformConfig, SecretOpener } from '@servicerouter/core';
import { createRedisInvalidationBus, createServiceRepository, type Postgres, type Redis } from '@servicerouter/db';

import { errorStatuses } from './errors.js';
import { createProxyMetrics } from './metrics.js';
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
  // Milliseconds since the epoch, for the cache's TTLs. Default: Date.now.
  readonly now?: () => number;
  readonly runtimeCache?: Partial<RuntimeCacheSettings>;
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

const registerResponseHeaders = (app: FastifyInstance): void => {
  // A CORS preflight is answered here, before any route: it never reaches an upstream
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS' && request.headers.origin !== undefined && request.headers['access-control-request-method'] !== undefined)
      return reply.status(204).headers(preflightHeaders).send();

    return undefined;
  });
  // Every response, proxied or not, including errors
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.headers({ ...securityHeaders, ...corsHeaders });

    return payload;
  });
};

/**
 * The proxy on pay.servicerouter.ai (PX-1 to PX-10, PX-16). Readiness covers Postgres and Redis.
 * Facilitators join it with x402 (PX-17).
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
}: ProxyDependencies): ProxyServer => {
  const server = createServer({
    logger,
    errorStatuses,
    requestIds,
    bodyLimit: config.sizeLimits.requestBodyBytes,
    readinessChecks: [
      { name: 'postgres', check: () => postgres.ping() },
      { name: 'redis', check: () => redis.ping() },
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
  registerProxyRoutes(app, { cache, http: upstreams, payUrl: config.urls.pay, metrics });

  // Invalidation (SR-7, SC-7): drop a service when it changes, and everything after a missed stretch
  const ownedBus = invalidation ? undefined : createRedisInvalidationBus({ redis, logger });
  const bus = invalidation ?? ownedBus!;
  const subscription = bus.subscribe(event => {
    metrics.invalidation(event.kind);
    if (event.kind === 'service')
      cache.invalidate(event.id);
  }, {
    onReconnect: () => {
      metrics.reconnect();
      cache.clear();
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
  });

  return { ...server, subscribed };
};
