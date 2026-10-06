import { collectDefaultMetrics, Counter, Histogram, Registry } from '@prometheus-io/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const metricsPath = '/metrics';

// The route label for a request that matched no route, so unknown URLs don't each get a series
export const unmatchedRoute = 'unmatched';

/** A metrics registry with the Node.js default metrics: CPU, memory, event loop, GC. */
export const createMetricsRegistry = (): Registry => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  return registry;
};

/** `GET /metrics` in the Prometheus text format, for the internal metrics listener only (XC-2). */
export const registerMetricsRoute = (app: FastifyInstance, registry: Registry): void => {
  app.get(metricsPath, async (_request, reply) => reply
    .header('content-type', registry.contentType)
    .send(await registry.metrics()));
};

/** The route pattern, such as `/v1/services/:id`. Never the URL, which may carry IDs or keys. */
export const routeOf = (request: FastifyRequest): string => request.routeOptions.url ?? unmatchedRoute;

/** Counts requests and records their latency by method, route, and status (XC-2). */
export const registerHttpMetrics = (app: FastifyInstance, registry: Registry): void => {
  const labelNames = ['method', 'route', 'status'] as const;
  const requests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests answered, by method, route, and status',
    labelNames,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds, by method, route, and status',
    labelNames,
    registers: [registry],
  });

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const labels = { method: request.method, route: routeOf(request), status: String(reply.statusCode) };
    requests.inc(labels);
    duration.observe(labels, reply.elapsedTime / 1_000);
  });
};
