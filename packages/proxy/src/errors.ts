import { ServiceRouterError, type ErrorStatusTable } from '@servicerouter/common';

// Every ServiceRouterError code the proxy answers with, and its status (CK-2). A code missing here
// answers an opaque 500. The proxy's codes arrive with its features.
export const errorStatuses = {
  // PX-1, RT-1
  invalid_target: 400,
  // Payment routing: a host we don't route to, a target that asks for no payment (RT-2, RT-3)
  host_not_allowed: 400,
  not_payable: 400,
  // Payment routing: no option we pay, or a retry above the quote. The buyer pays nothing (RT-4, RT-8).
  unsupported_payment: 502,
  quote_exceeded: 502,
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
  // An x402 payment that doesn't match the price, or that the facilitator rejected (PR-5). An MPP
  // credential that doesn't match, was used before, or that the Tempo node refuses (PR-9).
  payment_invalid: 402,
  // PX-4
  service_suspended: 403,
  not_found: 404,
  // PX-13
  rate_limited: 429,
  // x402 and MPP: the settlement failed or its outcome is unknown (PR-12, PR-9), or the response is over the buffer limit (PX-12, AR3)
  settlement_failed: 502,
  response_too_large: 502,
  // PX-7
  upstream_unavailable: 503,
  // A facilitator didn't answer a verify: nothing was paid (PR-5)
  facilitator_unavailable: 503,
  // MPP: the Tempo RPC or the replay store couldn't check the credential: nothing was paid (PR-9)
  payment_unavailable: 503,
} as const satisfies ErrorStatusTable;

/** An x402 or MPP response over the buffer limit (PX-12, AR3). It isn't sent, and the payment is cancelled. */
export class ResponseTooLargeError extends ServiceRouterError {
  readonly code = 'response_too_large';

  constructor() {
    super('The response is over the size a payment can wait for, so it wasn\'t sent. Nothing was charged.');
  }
}

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
