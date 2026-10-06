import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isServiceId, OutboundHttpError, type OutboundHttp, type OutboundResponse } from '@servicerouter/common';
import { declaresStatus, normalizePathText, type RuntimeOperation } from '@servicerouter/core';

import { InvalidTargetError, NotFoundError, ServiceSuspendedError, UpstreamUnavailableError } from '../errors.js';
import type { ProxyMetrics } from '../metrics.js';
import type { RuntimeCache } from './cache.js';
import { buildUpstreamRequest, createSelfLinkRewriter, filterResponseHeaders, type UpstreamRequest } from './forward.js';
import type { ServiceLoad } from './loader.js';
import { parseServicePath } from './path.js';

// Every method an operation may declare (SR-5). HEAD reaches only operations declared as head (PX-8).
export const proxiedMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'] as const;

// First path segments the platform keeps for itself (PX-1)
const platformSegments = new Set(['_', '.well-known']);

export interface ProxyRoutesOptions {
  readonly cache: RuntimeCache<ServiceLoad>;
  // Calls upstreams (rule 7). Its limits come from platform config (PX-8).
  readonly http: Pick<OutboundHttp, 'request'>;
  // The canonical pay URL from platform config (PX-10)
  readonly payUrl: string;
  readonly metrics: ProxyMetrics;
}

interface Prepared {
  readonly serviceId: string;
  readonly operation: RuntimeOperation;
  readonly upstreamRequest: UpstreamRequest;
}

const reasonOf = (error: unknown): string => error instanceof OutboundHttpError ? error.code : 'other';

/**
 * PX-1 for every path that isn't a registered service's or a platform route: no first segment (the
 * link checker, later), a platform path, or a hostname (payment routing, later) get `404`. Anything
 * else is `400 invalid_target`.
 */
const dispatch = async (request: FastifyRequest): Promise<never> => {
  const first = normalizePathText((request.raw.url ?? '/').split('?', 1)[0]!.split('/')[1] ?? '');
  if (first === '' || first === 'service' || platformSegments.has(first) || first.includes('.'))
    throw new NotFoundError();

  throw new InvalidTargetError();
};

/**
 * `/service/<service-id>/<path>` (PX-1 to PX-10): checks the path, finds the runtime, matches the
 * operation, and forwards to its upstream with the seller's credentials.
 */
export const registerProxyRoutes = (app: FastifyInstance, { cache, http, payUrl, metrics }: ProxyRoutesOptions): void => {
  // Everything up to the request to the upstream, while the runtime's secrets are leased (SC-5)
  const prepare = async (request: FastifyRequest): Promise<Prepared> => {
    // Dot segments are refused before anything is matched
    const { serviceId, segments, query } = parseServicePath(request.raw.url ?? '/');
    if (!isServiceId(serviceId))
      throw new NotFoundError();

    const lease = await cache.acquire(serviceId);
    try {
      const { found } = lease;
      if (found.kind === 'none')
        throw new NotFoundError();
      if (found.value === 'unavailable')
        throw new UpstreamUnavailableError();

      const { runtime, secrets } = found.value;
      if (runtime.state === 'suspended')
        throw new ServiceSuspendedError();
      if (runtime.state !== 'live')
        throw new NotFoundError();

      const match = runtime.match(request.method, segments);
      if (!match || !match.operation.enabled)
        throw new NotFoundError();

      return {
        serviceId,
        operation: match.operation,
        upstreamRequest: buildUpstreamRequest({ match, query, headers: request.headers, requestId: request.id, secrets }),
      };
    }
    finally {
      lease.release();
    }
  };

  const serve = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const { serviceId, operation, upstreamRequest } = await prepare(request);
    // A client that goes away stops the upstream call too
    const abort = new AbortController();
    reply.raw.once('close', () => abort.abort());

    const started = performance.now();
    const seconds = () => (performance.now() - started) / 1_000;
    let response: OutboundResponse;
    try {
      response = await http.request({
        url: upstreamRequest.url,
        method: request.method,
        headers: upstreamRequest.headers,
        body: request.body as Buffer | undefined,
        // Forward, never redirect (PX-2, OH-3)
        redirect: 'none',
        signal: abort.signal,
      });
    }
    catch (error) {
      metrics.upstream(serviceId, { reason: reasonOf(error) }, seconds());
      request.log.warn({ serviceId, error }, 'The upstream call failed');
      throw new UpstreamUnavailableError();
    }

    // PX-7: a status the operation doesn't declare is as opaque as a failure
    if (!declaresStatus(operation, response.status)) {
      response.dispose();
      metrics.upstream(serviceId, { reason: 'undeclared_status' }, seconds());
      request.log.warn({ serviceId, status: response.status }, 'The upstream answered with a status the operation doesn\'t declare');
      throw new UpstreamUnavailableError();
    }

    metrics.upstream(serviceId, { status: response.status }, seconds());
    const rewrite = createSelfLinkRewriter({ payUrl, serviceId, upstream: operation.upstream, requestUrl: response.url });
    reply.status(response.status).headers(filterResponseHeaders(response.headers, rewrite));
    if (request.method === 'HEAD' || response.status === 204 || response.status === 304) {
      response.dispose();
      return reply.send();
    }

    // Streamed as it arrives (PX-12). A failure from here on ends the connection: the status is out.
    return reply.send(response.body);
  };

  app.register(async scope => {
    // Bodies pass through as bytes, whatever their type, up to the request body limit (PX-5, PX-8)
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
    scope.route({ method: [...proxiedMethods], url: '/service/*', handler: serve });
    scope.route({ method: [...proxiedMethods], url: '/*', handler: dispatch });
    scope.route({ method: [...proxiedMethods], url: '/', handler: dispatch });
  });
};
