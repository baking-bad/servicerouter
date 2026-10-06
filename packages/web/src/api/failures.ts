import { writeLogLine, type LogOptions } from '../log';
import type { ApiFailure } from './http';

/**
 * Logs a failed Platform API read on the server (L-10): one JSON line with the path without its query,
 * the status, the error code, and the duration. `route` replaces a path that holds a token, such as
 * `/v1/topup/{token}`. A 404 is an answer, such as an unknown service, not a failure.
 */
export const logApiFailure = (route?: string, options?: LogOptions) => (failure: ApiFailure): void => {
  if (failure.status === 404)
    return;

  writeLogLine(failure.status >= 500 ? 'warn' : 'info', 'Reading the Platform API failed', {
    path: route ?? failure.path,
    status: failure.status,
    code: failure.code,
    ...failure.cause === undefined ? {} : { cause: failure.cause },
    durationMs: failure.durationMs,
  }, options);
};
