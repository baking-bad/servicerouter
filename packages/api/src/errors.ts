import { ServiceRouterError, type ErrorStatusTable } from '@servicerouter/common';

// Every ServiceRouterError code the Platform API answers with, and its status (CK-2, PA-3). A code
// missing here answers an opaque 500. Endpoints add their codes as they arrive.
export const errorStatuses = {
  // A malformed request that Fastify's own checks don't catch
  invalid_request: 400,
  // PA-2, AK-4
  unauthorized: 401,
  invalid_key: 401,
  wrong_key_type: 401,
  // PA-5
  rate_limited: 429,
  // Services and secrets (SR-2, SR-12, SC-10)
  invalid_config: 400,
  service_id_mismatch: 400,
  unused_secret: 400,
  forbidden: 403,
  not_found: 404,
  secret_origin_mismatch: 409,
  // An operator's credit reference reused for another account or amount (LG-3, PA-4)
  idempotency_conflict: 409,
  // A payout run that isn't waiting for approval (PO-6)
  conflict: 409,
} as const satisfies ErrorStatusTable;

/** A request the route can't take: the message says what's wrong, never quoting a value it carried. */
export class InvalidRequestError extends ServiceRouterError {
  readonly code = 'invalid_request';
}

/** The resource isn't in a state that allows the request, such as a payout run already approved. */
export class ConflictError extends ServiceRouterError {
  readonly code = 'conflict';
}

/** No such resource for the caller, such as another account's payment key. */
export class NotFoundError extends ServiceRouterError {
  readonly code = 'not_found';
}
