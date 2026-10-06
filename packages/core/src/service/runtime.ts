import type { MicroUsd, ServiceId } from '@servicerouter/common';

import type { BazaarMetadata } from './discovery.js';
import type { HttpMethod } from './document.js';

// The compiled form of a service revision (SR-5): what the proxy serves from step 3. Keep it small.

/** `pending` until every upstream host is verified, then `live`. `suspended` while a host is (SR-8). */
export type ServiceState = 'pending' | 'live' | 'suspended';

export interface RuntimeUpstream {
  /** `upstreams[].name`, when the seller gave one */
  readonly name: string | undefined;
  /** Without a trailing slash, keeping any path prefix, such as `https://api.example.com/v2` */
  readonly baseUrl: string;
  /** Scheme, host, and port of `baseUrl`, such as `https://api.example.com` */
  readonly origin: string;
  /** Path of `baseUrl`, percent-encoded, such as `/v2`. Empty without a prefix */
  readonly pathPrefix: string;
}

/** How the proxy sends a credential's secret to the upstream (PX-5). */
export type CredentialApplication =
  // Authorization: Bearer <secret>
  | { readonly type: 'bearer' }
  // Authorization: Basic <base64 of the secret>. The secret is user:password
  | { readonly type: 'basic' }
  // The secret as is, in the header, query parameter, or cookie with this name
  | { readonly type: 'apiKey'; readonly in: 'header' | 'query' | 'cookie'; readonly name: string };

export interface CredentialReference {
  /** The credential's name in `credentials` */
  readonly credential: string;
  readonly apply: CredentialApplication;
  /** The secret's name. A runtime never holds a secret value; the proxy opens it (SC-5) */
  readonly secretName: string;
}

export interface OperationDocs {
  readonly operationId: string | undefined;
  readonly summary: string | undefined;
  readonly description: string | undefined;
  /**
   * x402 Bazaar discovery metadata (AD-3), which the x402 challenge carries (PR-7): the same entry as
   * the revision's `bazaar.json`, with local references inlined. Undefined for a free or disabled
   * operation, and for every operation of a service with `discoverable: false` (P-4)
   */
  readonly bazaar: BazaarMetadata | undefined;
}

export interface RuntimeOperation {
  /** The key `routes` uses (SR-6): the operationId, or `<upstream>/<operationId>` when upstreams share it. Undefined without an operationId */
  readonly routeKey: string | undefined;
  readonly method: HttpMethod;
  /** The OpenAPI path template as declared, such as `/forecast/{city}` */
  readonly path: string;
  readonly upstream: RuntimeUpstream;
  /** Where to forward: `routes.<key>.target.path` or `path`, percent-encoded, with {parameters}. See `targetPath` */
  readonly target: string;
  /** What a call costs in micro-USD (CK-4): `payments.default`, then the route's named or inline payment */
  readonly price: MicroUsd;
  /** `routes.<key>.enabled`. A disabled operation still matches, and the proxy answers 404 (PX-4) */
  readonly enabled: boolean;
  /** The upstream's credentials, in config order. All of them are sent */
  readonly credentials: readonly CredentialReference[];
  /**
   * The keys of the operation's `responses`: codes such as `200`, ranges such as `2XX`, and `default`.
   * The proxy passes only a declared status (PX-7). See `declaresStatus`
   */
  readonly responses: readonly string[];
  readonly docs: OperationDocs;
}

export interface OperationMatch {
  readonly operation: RuntimeOperation;
  /** Path parameters by name, as matched: still percent-encoded */
  readonly params: Readonly<Record<string, string>>;
}

export interface ServiceRuntime {
  readonly serviceId: ServiceId;
  /** The revision it was compiled from */
  readonly revision: number;
  readonly state: ServiceState;
  /** Every operation of every upstream, in config order */
  readonly operations: readonly RuntimeOperation[];
  /**
   * Finds the operation for a request. `segments` is the path after `/service/<service-id>`, split on
   * `/` after the leading one, each still percent-encoded and normalized with `normalizePathText`. A
   * parameter matches one non-empty segment, and literal segments beat parameters, segment by segment
   * (PX-4). HEAD matches only operations declared as `head` (PX-8). Not enumerable, so runtimes compare
   * and print by their data.
   */
  match(method: string, segments: readonly string[]): OperationMatch | undefined;
}

// RFC 3986: characters a path may hold without percent-encoding
const pathCharacters = 'A-Za-z0-9\\-._~!$&\'()*+,;=:@/';
const encodedOrOther = new RegExp(`%[0-9A-Fa-f]{2}|[^${pathCharacters}]`, 'gu');
const unreserved = /^[A-Za-z0-9\-._~]$/;

/**
 * Normalizes percent-encoding the RFC 3986 way: encodes what a path can't hold as is, uppercases
 * hex digits, and decodes unreserved characters. Template literals are stored this way, so the
 * proxy normalizes request segments with the same function before matching.
 */
export const normalizePathText = (text: string): string => text.replace(encodedOrOther, token => {
  if (token.length === 3 && token.startsWith('%')) {
    const character = String.fromCharCode(parseInt(token.slice(1), 16));

    return unreserved.test(character) ? character : token.toUpperCase();
  }
  try {
    return encodeURIComponent(token);
  }
  catch {
    // A lone surrogate: U+FFFD, the replacement character
    return '%EF%BF%BD';
  }
});

const parameterPattern = /\{([^{}]+)\}/g;

/** The upstream request path: the base URL's path prefix, then the target with params filled in, still percent-encoded. */
export const targetPath = (operation: RuntimeOperation, params: Readonly<Record<string, string>>): string =>
  operation.upstream.pathPrefix + operation.target.replace(parameterPattern, (_placeholder, name: string) => {
    if (!Object.hasOwn(params, name))
      throw new TypeError(`The parameter ${name} is missing`);

    return params[name]!;
  });

/**
 * Whether the operation declares this response status (PX-7): its code, its range such as `2XX`, or
 * `default`. An operation without `responses` declares none, so the proxy passes none of its answers.
 */
export const declaresStatus = (operation: Pick<RuntimeOperation, 'responses'>, status: number): boolean =>
  operation.responses.some(key => key === 'default' || key === String(status) || key === `${Math.floor(status / 100)}XX`);
