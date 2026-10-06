import type { IncomingHttpHeaders } from 'node:http';

import type { OutboundHeaders, Secret } from '@servicerouter/common';
import { targetPath, type CredentialReference, type OperationMatch, type RuntimeUpstream } from '@servicerouter/core';

// PX-5: the only client request headers an upstream sees. Everything else is dropped, including
// Authorization, Cookie, and the payment headers. content-length is computed again from the body.
export const forwardedRequestHeaders: ReadonlySet<string> = new Set([
  'accept', 'accept-encoding', 'accept-language', 'cache-control', 'content-digest', 'content-encoding', 'content-language',
  'content-length', 'content-type', 'digest', 'idempotency-key', 'if-match', 'if-modified-since', 'if-none-match', 'if-range',
  'if-unmodified-since', 'prefer', 'range', 'repr-digest', 'want-content-digest', 'want-digest', 'want-repr-digest',
]);

// PX-6: the only upstream response headers a client sees. Never Set-Cookie: every service shares one origin.
export const forwardedResponseHeaders: ReadonlySet<string> = new Set([
  'accept-ranges', 'age', 'allow', 'cache-control', 'content-digest', 'content-disposition', 'content-encoding', 'content-language',
  'content-length', 'content-range', 'content-type', 'deprecation', 'digest', 'etag', 'expires', 'last-modified', 'preference-applied',
  'ratelimit', 'ratelimit-policy', 'repr-digest', 'retry-after', 'sunset', 'vary', 'x-ratelimit-limit', 'x-ratelimit-remaining',
  'x-ratelimit-reset', 'location', 'content-location', 'link',
]);

export interface UpstreamRequest {
  readonly url: string;
  readonly headers: OutboundHeaders;
}

export interface BuildUpstreamRequestInput {
  readonly match: OperationMatch;
  // The client's query as received, without the `?`
  readonly query: string;
  readonly headers: IncomingHttpHeaders;
  readonly requestId: string;
  // The service's opened secrets, by name (SC-5)
  readonly secrets: ReadonlyMap<string, Secret>;
}

const decodeQueryName = (name: string): string => {
  try {
    return decodeURIComponent(name.replaceAll('+', ' '));
  }
  catch {
    return name;
  }
};

// A client can't send its own value for a query parameter the seller's credential sets
const withoutQueryParameter = (query: string, name: string): string =>
  query.split('&').filter(pair => decodeQueryName(pair.split('=', 1)[0]!) !== name).join('&');

/** Puts the seller's credentials on the request, after filtering (PX-5). */
const applyCredentials = (
  credentials: readonly CredentialReference[],
  secrets: ReadonlyMap<string, Secret>,
  headers: Record<string, string | readonly string[]>,
  query: string,
): string => {
  let result = query;
  const cookies: string[] = [];
  for (const { apply, secretName } of credentials) {
    const secret = secrets.get(secretName);
    // The loader opens every secret a runtime's credentials use, or the service doesn't load
    if (!secret)
      throw new Error('A credential\'s secret is not open');

    const value = secret.expose();
    if (apply.type === 'bearer')
      headers['authorization'] = `Bearer ${value}`;
    else if (apply.type === 'basic')
      headers['authorization'] = `Basic ${Buffer.from(value, 'utf8').toString('base64')}`;
    else if (apply.in === 'header')
      headers[apply.name.toLowerCase()] = value;
    else if (apply.in === 'query') {
      const kept = withoutQueryParameter(result, apply.name);
      result = `${kept}${kept ? '&' : ''}${encodeURIComponent(apply.name)}=${encodeURIComponent(value)}`;
    }
    else
      cookies.push(`${apply.name}=${value}`);
  }
  if (cookies.length > 0)
    headers['cookie'] = cookies.join('; ');

  return result;
};

/**
 * The request to the upstream (PX-5): the allowlisted client headers, `x-request-id`, then the seller's
 * credentials; the target path with the base URL's prefix (`targetPath`), and the client's query.
 */
export const buildUpstreamRequest = ({ match, query, headers, requestId, secrets }: BuildUpstreamRequestInput): UpstreamRequest => {
  const forwarded: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    // The body is sent as received, and its length is set from it again
    if (value !== undefined && name !== 'content-length' && forwardedRequestHeaders.has(name))
      forwarded[name] = value;
  }
  forwarded['x-request-id'] = requestId;
  const { operation, params } = match;
  const finalQuery = applyCredentials(operation.credentials, secrets, forwarded, query);

  return {
    url: `${operation.upstream.origin}${targetPath(operation, params)}${finalQuery ? `?${finalQuery}` : ''}`,
    headers: forwarded,
  };
};

export interface SelfLinkOptions {
  // The canonical pay URL from platform config, never the request's Host (PX-10)
  readonly payUrl: string;
  readonly serviceId: string;
  readonly upstream: RuntimeUpstream;
  // The upstream request's URL, which relative references resolve against
  readonly requestUrl: URL;
}

/**
 * Rewrites a URL from an upstream header into the proxy's own (PX-6, PX-10). A URL on the upstream's
 * base URL becomes `<pay URL>/service/<id>/…`. One elsewhere on the upstream's origin would reveal it,
 * so it is dropped (undefined). One on another origin is kept as it is.
 */
export const createSelfLinkRewriter = ({ payUrl, serviceId, upstream, requestUrl }: SelfLinkOptions) =>
  (value: string): string | undefined => {
    let url: URL;
    try {
      url = new URL(value, requestUrl);
    }
    catch {
      return undefined;
    }
    if (url.origin !== upstream.origin)
      return value;

    const prefix = upstream.pathPrefix;
    if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
      return undefined;

    return `${payUrl.replace(/\/+$/, '')}/service/${serviceId}${url.pathname.slice(prefix.length) || '/'}${url.search}${url.hash}`;
  };

// Splits a Link header on the commas between links, not those inside a URI or a quoted parameter
const splitLinks = (value: string): string[] => {
  const links: string[] = [];
  let current = '';
  let inUri = false;
  let inQuotes = false;
  for (const character of value) {
    if (character === '"' && !inUri)
      inQuotes = !inQuotes;
    else if (character === '<' && !inQuotes)
      inUri = true;
    else if (character === '>' && !inQuotes)
      inUri = false;
    else if (character === ',' && !inUri && !inQuotes) {
      links.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  links.push(current.trim());

  return links.filter(link => link !== '');
};

/** Rewrites each link's URI in a Link header, dropping those the rewriter drops. Undefined when none is left. */
export const rewriteLinkHeader = (value: string, rewrite: (url: string) => string | undefined): string | undefined => {
  const links = splitLinks(value).flatMap(link => {
    const parts = /^<([^>]*)>(.*)$/s.exec(link);
    const target = parts ? rewrite(parts[1]!) : undefined;

    return target === undefined ? [] : [`<${target}>${parts![2]}`];
  });

  return links.length > 0 ? links.join(', ') : undefined;
};

/**
 * The upstream response headers a client may see (PX-6): the allowlist, with `Location`,
 * `Content-Location`, and `Link` rewritten to the proxy's own URLs (PX-10).
 */
export const filterResponseHeaders = (
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  rewrite: (url: string) => string | undefined,
): Record<string, string | string[]> => {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || !forwardedResponseHeaders.has(lower))
      continue;

    const values = typeof value === 'string' ? [value] : [...value];
    const kept = lower === 'link'
      ? values.flatMap(item => rewriteLinkHeader(item, rewrite) ?? [])
      : lower === 'location' || lower === 'content-location'
        ? values.flatMap(item => rewrite(item) ?? [])
        : values;
    if (kept.length > 0)
      result[lower] = kept.length === 1 ? kept[0]! : kept;
  }

  return result;
};
