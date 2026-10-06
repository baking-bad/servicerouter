import { ServiceRouterError, type ErrorStatusTable } from '@servicerouter/common';

// Every ServiceRouterError code the proxy answers with, and its status (CK-2). A code missing here
// answers an opaque 500. The proxy's codes arrive with its features.
export const errorStatuses = {
  // PX-1
  invalid_target: 400,
  // Dot segments, raw or encoded (PX-4)
  invalid_path: 400,
  // Two or more payment credentials (PR-1)
  multiple_payment_methods: 400,
  // GET /_/key without a payment key (AK-8)
  unauthorized: 401,
  // An unknown, revoked, expired, or malformed payment key, and a master key (AK-4, PR-4)
  invalid_key: 401,
  wrong_key_type: 401,
  // The hold or the key's limits refused the price (PR-4, LG-6)
  insufficient_balance: 402,
  key_budget_exceeded: 402,
  key_allowance_exceeded: 402,
  key_price_limit: 402,
  // PX-4
  service_suspended: 403,
  not_found: 404,
  // PX-13
  rate_limited: 429,
  // PX-7
  upstream_unavailable: 503,
} as const satisfies ErrorStatusTable;

/** `GET /_/key` without a payment key (AK-8). */
export class KeyRequiredError extends ServiceRouterError {
  readonly code = 'unauthorized';

  constructor() {
    super('GET /_/key needs a payment key: Authorization: Bearer <key>');
  }
}

/** The first path segment isn't `service`, a platform path, or a hostname (PX-1). */
export class InvalidTargetError extends ServiceRouterError {
  readonly code = 'invalid_target';

  constructor() {
    super('The path must start with /service/<service-id>/');
  }
}

/** A `.` or `..` segment, raw or percent-encoded, which would reach outside the matched path (PX-4). */
export class InvalidPathError extends ServiceRouterError {
  readonly code = 'invalid_path';

  constructor() {
    super('The path must not hold "." or ".." segments, raw or encoded');
  }
}

/** An unknown service or operation, a disabled route, or a service that isn't live yet (PX-4). */
export class NotFoundError extends ServiceRouterError {
  readonly code = 'not_found';

  constructor() {
    super('Not found');
  }
}

/** The service is suspended while a host fails verification (PX-4, SR-8). */
export class ServiceSuspendedError extends ServiceRouterError {
  readonly code = 'service_suspended';

  constructor() {
    super('The service is suspended');
  }
}

/** Any upstream failure, and a service that can't load. One opaque answer: nothing upstream leaks (PX-7). */
export class UpstreamUnavailableError extends ServiceRouterError {
  readonly code = 'upstream_unavailable';

  constructor() {
    super('The upstream is unavailable');
  }
}
