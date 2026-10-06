import type { AddressInfo } from 'node:net';

import type { Registry } from '@prometheus-io/client';
import fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import type { Logger } from '../logging.js';
import { randomIdGenerator, type IdGenerator } from '../ports.js';
import { createErrorHandler, notFoundResponse, type ErrorStatusTable } from './errors.js';
import { registerHealthRoutes, type ReadinessCheck } from './health.js';
import { createMetricsRegistry, registerHttpMetrics, registerMetricsRoute } from './metrics.js';
import { createRequestIdGenerator, requestIdHeader } from './requestId.js';
import { RequestLogController } from './requestLog.js';

const defaultBodyLimit = 1_048_576;

interface BaseOptions {
  readonly logger: Logger;
  // The app's code-to-status table (CK-2). Codes missing from it answer an opaque 500.
  readonly errorStatuses?: ErrorStatusTable;
  // Default: 1 MiB
  readonly bodyLimit?: number;
  // Request IDs for requests without a valid `x-request-id`. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
}

interface FastifyOptions extends BaseOptions {
  // One log line per request. Off on the metrics listener, which Prometheus scrapes all day.
  readonly requestLogging: boolean;
}

export interface ServerOptions extends BaseOptions {
  // What `/_/ready` covers, such as Postgres and Redis. None: always ready.
  readonly readinessChecks?: readonly ReadinessCheck[];
  // Each readiness check's deadline. Default: 2 s.
  readonly readinessTimeoutMs?: number;
}

export interface ServerAddresses {
  readonly port: number;
  readonly metricsPort: number;
}

export interface ListenOptions extends ServerAddresses {
  readonly host: string;
}

/** An app's public listener, plus its metrics listener on a port of its own. */
export interface Server {
  // The public listener. Apps add their routes here before `listen`.
  readonly app: FastifyInstance;
  readonly metrics: MetricsServer;
  /** Starts both listeners and returns their ports. Port 0 picks a free one. */
  listen(options: ListenOptions): Promise<ServerAddresses>;
  /** Stops accepting, waits for in-flight requests, then closes the metrics listener (CK-6). */
  close(): Promise<void>;
}

export type MetricsServerOptions = Pick<ServerOptions, 'logger' | 'readinessChecks' | 'readinessTimeoutMs'> & {
  // Also serve `/_/health` and `/_/ready`, for an app with no public listener. Default: false.
  readonly health?: boolean;
};

/** The internal metrics listener: `GET /metrics`, and for an app without a public listener, health too. */
export interface MetricsServer {
  readonly app: FastifyInstance;
  readonly registry: Registry;
  /** Starts the listener and returns its port. Port 0 picks a free one. */
  listen(options: { readonly host: string; readonly port: number }): Promise<number>;
  close(): Promise<void>;
}

const createFastify = ({
  logger,
  errorStatuses = {},
  bodyLimit = defaultBodyLimit,
  requestIds = randomIdGenerator,
  requestLogging,
}: FastifyOptions): FastifyInstance => {
  const app = fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // Request logs with metadata only, and the request ID on every line (XC-5, XC-7)
    logController: new RequestLogController({ enabled: requestLogging }),
    // A HEAD route would reach a paid GET for free (PX-8)
    exposeHeadRoutes: false,
    // While draining, requests on open connections are still served, with `Connection: close`
    return503OnClosing: false,
    bodyLimit,
    requestIdHeader: false,
    genReqId: createRequestIdGenerator(requestIds),
  });
  app.setErrorHandler(createErrorHandler(errorStatuses));
  app.setNotFoundHandler(async (_request, reply) => reply.status(404).send(notFoundResponse.body));

  return app;
};

const listenOn = async (app: FastifyInstance, host: string, port: number): Promise<number> => {
  await app.listen({ host, port });

  return (app.server.address() as AddressInfo).port;
};

export const createMetricsServer = ({
  logger,
  readinessChecks = [],
  readinessTimeoutMs,
  health = false,
}: MetricsServerOptions): MetricsServer => {
  const app = createFastify({ logger, requestLogging: false });
  const registry = createMetricsRegistry();
  registerMetricsRoute(app, registry);
  if (health)
    registerHealthRoutes(app, { checks: readinessChecks, timeoutMs: readinessTimeoutMs });

  return {
    app,
    registry,
    listen: ({ host, port }) => listenOn(app, host, port),
    close: () => app.close(),
  };
};

/**
 * The server every app with a public listener runs (XC-1, XC-2, XC-3, XC-5, XC-7):
 * - the request ID from a valid `x-request-id`, or a new one, on the response and every log line;
 * - one log line per request with method, route, status, sizes, latency, and request ID, never the URL;
 * - the error envelope, with statuses from the app's table, and `404 not_found` for unknown routes;
 * - no automatic HEAD routes;
 * - `/_/health` and `/_/ready`;
 * - request count and latency on the metrics listener.
 */
export const createServer = ({ readinessChecks = [], readinessTimeoutMs, ...options }: ServerOptions): Server => {
  const app = createFastify({ ...options, requestLogging: true });
  const metrics = createMetricsServer({ logger: options.logger });

  app.addHook('onRequest', async (request, reply) => {
    reply.header(requestIdHeader, request.id);
  });
  registerHttpMetrics(app, metrics.registry);
  registerHealthRoutes(app, { checks: readinessChecks, timeoutMs: readinessTimeoutMs });

  return {
    app,
    metrics,
    listen: async ({ host, port, metricsPort }) => {
      const [publicPort, internalPort] = await Promise.allSettled([listenOn(app, host, port), metrics.listen({ host, port: metricsPort })]);
      if (publicPort.status === 'rejected' || internalPort.status === 'rejected') {
        // Such as a port in use. Neither listener stays open.
        await Promise.allSettled([app.close(), metrics.close()]);
        throw publicPort.status === 'rejected' ? publicPort.reason : (internalPort as PromiseRejectedResult).reason;
      }

      return { port: publicPort.value, metricsPort: internalPort.value };
    },
    close: async () => {
      await app.close();
      await metrics.close();
    },
  };
};
