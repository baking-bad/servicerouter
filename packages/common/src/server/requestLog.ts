import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';

import { routeOf } from './metrics.js';

// The field that carries the request ID on every log line of a request (XC-5)
export const requestIdLogLabel = 'requestId';

const contentLength = (value: unknown): number | undefined => {
  const length = Number(value);

  return value !== undefined && value !== '' && Number.isSafeInteger(length) && length >= 0 ? length : undefined;
};

/**
 * Fastify's own log lines carry the URL, the client address, and headers. This controller replaces
 * them with one line per request holding metadata only: method, route, status, sizes, latency, and,
 * through the request's logger, the request ID (XC-1, XC-7, CK-3). The URL is never logged, since a
 * route may put a key in the query.
 */
export class RequestLogController extends LogController {
  constructor({ enabled }: { readonly enabled: boolean }) {
    super({ disableRequestLogging: !enabled, requestIdLogLabel });
  }

  override incomingRequest(): void {
    // One line per request, written when it completes
  }

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request))
      return;

    const fields = {
      method: request.method,
      route: routeOf(request),
      status: reply.statusCode,
      requestBytes: contentLength(request.headers['content-length']),
      responseBytes: contentLength(reply.getHeader('content-length')),
      durationMs: Math.round(reply.elapsedTime * 1_000) / 1_000,
    };
    if (error)
      request.log.warn({ ...fields, error }, 'Request ended with an error');
    else
      request.log.info(fields, 'Request completed');
  }

  override routeNotFound(): void {
    // The request line records the 404, without the URL
  }

  override defaultErrorLog(error: Error, request: FastifyRequest): void {
    // Only reached without an app error handler. Logs the error, never the request.
    request.log.error({ error }, 'Request failed');
  }

  override writeHeadError(error: Error, request: FastifyRequest): void {
    request.log.warn({ error }, 'Failed to write the error response');
  }

  override streamError(error: Error & { readonly code?: unknown }, request: FastifyRequest): void {
    if (this.isLogDisabled(request))
      return;

    // A streamed body failed after the status went out, such as a proxied upstream breaking off. Fastify's
    // own line would carry the whole reply; this one carries the error only.
    if (error.code === 'ERR_STREAM_PREMATURE_CLOSE')
      request.log.info('The response stream closed early');
    else
      request.log.warn({ error }, 'The response stream failed after its headers were sent');
  }
}
