import { ServiceRouterError } from '../errors.js';

/**
 * Base class for every Outbound HTTP failure. Messages name the host, never the URL: a URL can carry
 * a credential in its query. Callers decide what a client sees; the proxy shows none of it (PX-7).
 */
export abstract class OutboundHttpError extends ServiceRouterError {
  readonly host: string;

  constructor(host: string, message: string, options?: ErrorOptions) {
    super(message, options);

    this.host = host;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), host: this.host };
  }
}

/** The URL isn't HTTPS, carries credentials, or can't be parsed (OH-6). */
export class UrlNotAllowedError extends OutboundHttpError {
  readonly code = 'url_not_allowed';
}

/** The host or one of its addresses belongs to the platform (OH-5). */
export class OwnHostError extends OutboundHttpError {
  readonly code = 'own_host';

  constructor(host: string) {
    super(host, `${host} is a platform host`);
  }
}

/** The host resolves to an address the policy refuses (OH-1). */
export class BlockedAddressError extends OutboundHttpError {
  readonly code = 'blocked_address';
  readonly address: string;

  constructor(host: string, address: string, reason: string) {
    super(host, `${host} resolves to ${reason}`);

    this.address = address;
  }
}

export class DnsLookupError extends OutboundHttpError {
  readonly code = 'dns_lookup_failed';

  constructor(host: string, options?: ErrorOptions) {
    super(host, `${host} could not be resolved`, options);
  }
}

/** A redirect the call's policy doesn't allow (OH-3). */
export class RedirectNotAllowedError extends OutboundHttpError {
  readonly code = 'redirect_not_allowed';
}

export type TimeoutPhase = 'connect' | 'total';

export class OutboundTimeoutError extends OutboundHttpError {
  readonly code = 'outbound_timeout';
  readonly phase: TimeoutPhase;
  readonly timeoutMs: number;

  constructor(host: string, phase: TimeoutPhase, timeoutMs: number) {
    super(host, `The ${phase === 'connect' ? 'connection to' : 'request to'} ${host} timed out after ${timeoutMs} ms`);

    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

export class RequestTooLargeError extends OutboundHttpError {
  readonly code = 'request_too_large';

  constructor(host: string, limit: number) {
    super(host, `The request body for ${host} exceeds ${limit} bytes`);
  }
}

export class ResponseTooLargeError extends OutboundHttpError {
  readonly code = 'response_too_large';

  constructor(host: string, limit: number) {
    super(host, `The response from ${host} exceeds ${limit} bytes`);
  }
}

/** The connection failed or broke: refused, reset, TLS verification failed. The cause has details for logs. */
export class ConnectionFailedError extends OutboundHttpError {
  readonly code = 'connection_failed';

  constructor(host: string, options?: ErrorOptions) {
    super(host, `The connection to ${host} failed`, options);
  }
}

/** Outbound HTTP was built with an address policy that production may not use (OH-7). */
export class AddressPolicyNotAllowedError extends ServiceRouterError {
  readonly code = 'address_policy_not_allowed';

  constructor() {
    super('Outbound HTTP accepts only the public address policy in production');
  }
}
