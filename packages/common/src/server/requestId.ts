import type { IncomingMessage } from 'node:http';

import type { IdGenerator } from '../ports.js';
import { isRequestId, type RequestId } from '../types.js';

export const requestIdHeader = 'x-request-id';

/**
 * Keeps a valid incoming `x-request-id` and generates one otherwise (XC-5). A header that isn't a
 * valid request ID is replaced, so nothing a client sends unchecked reaches the logs.
 */
export const createRequestIdGenerator = (ids: IdGenerator) => (request: IncomingMessage): RequestId => {
  const incoming = request.headers[requestIdHeader];

  return typeof incoming === 'string' && isRequestId(incoming) ? incoming : ids.next();
};
