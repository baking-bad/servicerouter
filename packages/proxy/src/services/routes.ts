import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  isServiceId, OutboundHttpError, ResponseTooLargeError as OutboundResponseTooLargeError, type OutboundHttp, type OutboundResponse,
} from '@servicerouter/common';
import { declaresStatus, normalizePathText, type RuntimeOperation } from '@servicerouter/core';

import { InvalidTargetError, NotFoundError, ResponseTooLargeError, ServiceSuspendedError, UpstreamUnavailableError } from '../errors.js';
import type { ProxyMetrics } from '../metrics.js';
import type { PaidCall, PaymentStep } from '../payments/step.js';
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
  // Runs the payment rails around the forward, for an operation with a price (rule 5)
  readonly payments: PaymentStep;
}

interface Prepared {
  readonly serviceId: string;
  readonly ownerAccountId: string;
  readonly operation: RuntimeOperation;
  // The path after the service ID, such as `/weather/oslo`
  readonly path: string;
  readonly upstreamRequest: UpstreamRequest;
}

const reasonOf = (error: unknown): string => error instanceof OutboundHttpError ? error.code : 'other';

/**
 * The upstream's headers with a receipt's (PX-6). A receipt's `Cache-Control`, such as MPP's `private`
 * (PR-9), joins the upstream's directives instead of replacing them, and `private` drops `public`.
 */
const withReceipt = (headers: Record<string, string | string[]>, receipt: Readonly<Record<string, string>>): Record<string, string | string[]> => {
  const extra = receipt['cache-control'];
  if (extra === undefined)
    return { ...headers, ...receipt };

  const upstream = headers['cache-control'];
  const directives = [...(Array.isArray(upstream) ? upstream : upstream === undefined ? [] : [upstream]), extra]
    .flatMap(value => value.split(','))
    .map(directive => directive.trim())
    .filter(directive => directive !== '');
  const isPrivate = directives.some(directive => directive.toLowerCase() === 'private');
  const kept = new Map<string, string>();
  for (const directive of directives) {
    if (!(isPrivate && directive.toLowerCase() === 'public'))
      kept.set(directive.toLowerCase(), directive);
  }

  return { ...headers, ...receipt, 'cache-control': [...kept.values()].join(', ') };
};

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
 * `/service/<service-id>/<path>` (PX-1 to PX-12): checks the path, finds the runtime, matches the
 * operation, takes the payment for a priced one, and forwards to its upstream with the seller's
 * credentials. An operation priced at 0 is free: no payment step.
 */
export const registerProxyRoutes = (app: FastifyInstance, { cache, http, payUrl, metrics, payments }: ProxyRoutesOptions): void => {
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

      const { runtime, secrets, ownerAccountId } = found.value;
      if (runtime.state === 'suspended')
        throw new ServiceSuspendedError();
      if (runtime.state !== 'live')
        throw new NotFoundError();

      const match = runtime.match(request.method, segments);
      if (!match || !match.operation.enabled)
        throw new NotFoundError();

      return {
        serviceId,
        ownerAccountId,
        operation: match.operation,
        path: `/${segments.join('/')}`,
        upstreamRequest: buildUpstreamRequest({ match, query, headers: request.headers, requestId: request.id, secrets }),
      };
    }
    finally {
      lease.release();
    }
  };

  /**
   * x402 and MPP (PX-12, PR-12, PR-9): no upstream byte reaches the buyer before the money moves. A
   * billable answer is buffered up to the limit (AR3), settled, then sent with its receipt. Anything
   * else is cancelled and passes as it is: nothing was paid for it.
   */
  const settleThenSend = async (
    reply: FastifyReply,
    call: PaidCall,
    response: OutboundResponse,
    answer: { readonly headers: Record<string, string | string[]>; readonly bodyless: boolean; readonly latencyMs: number },
  ): Promise<FastifyReply> => {
    const decision = await payments.decide(call, { status: response.status, latencyMs: answer.latencyMs });
    if (decision !== 'billable') {
      await payments.finish(call, decision);
      reply.status(response.status).headers(answer.headers);
      if (answer.bodyless) {
        response.dispose();
        return reply.send();
      }

      return reply.send(response.body);
    }

    let body: Buffer | undefined;
    if (answer.bodyless)
      response.dispose();
    else {
      try {
        body = await response.bytes();
      }
      catch (error) {
        // Too large to buffer, or the upstream broke off: cancel, nothing settles
        await payments.finish(call, 'not_billable');
        throw error instanceof OutboundResponseTooLargeError ? new ResponseTooLargeError() : new UpstreamUnavailableError();
      }
    }
    // Throws SettlementFailedError (502) when the response must not go out
    const receipt = await payments.settleNow(call);

    return reply.status(response.status).headers(withReceipt(answer.headers, receipt.headers)).send(body);
  };

  const serve = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const { serviceId, ownerAccountId, operation, path, upstreamRequest } = await prepare(request);
    // Rule 5: authorize before forwarding. No credential gets the combined 402 (PR-2).
    let paid: PaidCall | undefined;
    let forwardHeaders = upstreamRequest.headers;
    if (operation.price > 0n) {
      const payment = await payments.begin({
        headers: request.headers, ip: request.ip, requestId: request.id, serviceId, ownerAccountId, operation, path,
      });
      if (payment.kind === 'challenge')
        return reply.status(payment.response.status).headers(payment.response.headers).send(payment.response.body);

      paid = payment.call;
      forwardHeaders = { ...forwardHeaders, ...payment.upstreamHeaders };
    }

    // A client that goes away stops the upstream call too
    const abort = new AbortController();
    reply.raw.once('close', () => abort.abort());

    const started = performance.now();
    const seconds = () => (performance.now() - started) / 1_000;
    // No usable answer: nothing is billable, and the payment goes back before the opaque 503 (PX-7)
    const unavailable = async (): Promise<never> => {
      if (paid)
        await payments.finish(paid, await payments.decide(paid, { status: undefined, latencyMs: Math.round(seconds() * 1_000) }));
      throw new UpstreamUnavailableError();
    };
    let response: OutboundResponse;
    try {
      response = await http.request({
        url: upstreamRequest.url,
        method: request.method,
        headers: forwardHeaders,
        body: request.body as Buffer | undefined,
        // Forward, never redirect (PX-2, OH-3)
        redirect: 'none',
        signal: abort.signal,
      });
    }
    catch (error) {
      metrics.upstream(serviceId, { reason: reasonOf(error) }, seconds());
      request.log.warn({ serviceId, error }, 'The upstream call failed');
      return unavailable();
    }

    // PX-7: a status the operation doesn't declare is as opaque as a failure
    if (!declaresStatus(operation, response.status)) {
      response.dispose();
      metrics.upstream(serviceId, { reason: 'undeclared_status' }, seconds());
      request.log.warn({ serviceId, status: response.status }, 'The upstream answered with a status the operation doesn\'t declare');
      return unavailable();
    }

    metrics.upstream(serviceId, { status: response.status }, seconds());
    // The body can fail while the decision is recorded, before anyone reads it: past the size limit,
    // or cut off. Unheard, that error would crash the process. Whoever reads the body still gets it.
    response.body.on('error', () => undefined);
    const rewrite = createSelfLinkRewriter({ payUrl, serviceId, upstream: operation.upstream, requestUrl: response.url });
    const headers = filterResponseHeaders(response.headers, rewrite);
    const bodyless = request.method === 'HEAD' || response.status === 204 || response.status === 304;
    if (paid?.rail.settlesBeforeResponse)
      return settleThenSend(reply, paid, response, { headers, bodyless, latencyMs: Math.round(seconds() * 1_000) });

    reply.status(response.status).headers(headers);
    if (paid) {
      // Decide and record (rule 5, PX-11), then finalize once the response is out or the client has
      // gone, even while the decision is still being written. A client that leaves after the decision
      // still follows it.
      const call = paid;
      const deciding = payments.decide(call, { status: response.status, latencyMs: Math.round(seconds() * 1_000) });
      reply.raw.once('close', () => {
        void (async () => payments.finish(call, await deciding))();
      });
      const decision = await deciding;
      if (decision === 'billable')
        reply.headers(call.authorization.receipt?.headers ?? {});
    }
    if (bodyless) {
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
