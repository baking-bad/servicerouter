import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

import { safeStack } from '../diagnostics.js';
import { ServiceRouterError } from '../errors.js';
import { recordErrorCode } from './requestLog.js';

/** Maps a `ServiceRouterError` code to the HTTP status an app answers with. One table per app (CK-2). */
export type ErrorStatusTable = Readonly<Record<string, number>>;

/** The one error envelope on every app (PA-3). */
export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

interface ErrorResponse {
  readonly status: number;
  readonly body: ErrorBody;
}

// Codes the server itself answers with. Like every code, they are part of the API: never rename one.
export const serverErrorCodes = {
  notFound: 'not_found',
  invalidRequest: 'invalid_request',
  requestTooLarge: 'request_too_large',
  unsupportedMediaType: 'unsupported_media_type',
  internalError: 'internal_error',
} as const;

const errorResponse = (status: number, code: string, message: string): ErrorResponse => ({
  status,
  body: { error: { code, message } },
});

export const notFoundResponse = errorResponse(404, serverErrorCodes.notFound, 'Not found');
const internalErrorResponse = errorResponse(500, serverErrorCodes.internalError, 'Internal server error');

const isFastifyError = (error: unknown): error is FastifyError =>
  error instanceof Error && typeof (error as Partial<FastifyError>).code === 'string'
  && (error as FastifyError).code.startsWith('FST_') && typeof (error as Partial<FastifyError>).statusCode === 'number';

// Fastify rejects a malformed request before any route runs. Its messages are fixed strings, except for
// JSON syntax errors, which quote the body, so those get a message of our own.
const fromFastifyError = (error: FastifyError): ErrorResponse | undefined => {
  const status = error.statusCode ?? 500;
  if (error.validation)
    return errorResponse(400, serverErrorCodes.invalidRequest, error.message);
  if (status === 413)
    return errorResponse(413, serverErrorCodes.requestTooLarge, 'The request body is too large');
  if (status === 415)
    return errorResponse(415, serverErrorCodes.unsupportedMediaType, 'The content type is not supported');
  if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY')
    return errorResponse(400, serverErrorCodes.invalidRequest, 'The request body is not valid JSON');
  if (status >= 400 && status < 500)
    return errorResponse(status, serverErrorCodes.invalidRequest, error.message);

  return undefined;
};

/**
 * Turns an error into the response a client sees. A `ServiceRouterError` whose code is in the app's
 * table keeps its code and message. Anything else, including a code the app doesn't map, becomes an
 * opaque `500 internal_error`, so no internal detail reaches a client (XC-7).
 */
export const toErrorResponse = (error: unknown, statuses: ErrorStatusTable): ErrorResponse => {
  if (error instanceof ServiceRouterError) {
    return Object.hasOwn(statuses, error.code)
      ? errorResponse(statuses[error.code]!, error.code, error.message)
      : internalErrorResponse;
  }

  return (isFastifyError(error) ? fromFastifyError(error) : undefined) ?? internalErrorResponse;
};

export const createErrorHandler = (statuses: ErrorStatusTable) =>
  (error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply => {
    const { status, body } = toErrorResponse(error, statuses);
    // A 4xx's code goes on the request line, at info (L-7)
    recordErrorCode(request, body.error.code);
    // The error, its cause chain, and its stack go to the log only, never to the client (XC-7, L-9). A
    // coded error answering internal_error has a code the app doesn't map: a bug, so its stack too.
    if (status >= 500) {
      const unmapped = error instanceof ServiceRouterError && body.error.code === serverErrorCodes.internalError;
      const stack = unmapped ? safeStack(error) : undefined;
      request.log.error({ error, ...stack === undefined ? {} : { stack } }, 'Request failed');
    }

    return reply.status(status).send(body);
  };
