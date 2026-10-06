import type { LookupAddress, LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Readable, Transform } from 'node:stream';

import { Agent, type Dispatcher } from 'undici';

import { systemTimers, type Timers } from '../ports.js';
import { publicAddressPolicy, type AddressPolicy } from './addressPolicy.js';
import {
  AddressPolicyNotAllowedError, BlockedAddressError, ConnectionFailedError, DnsLookupError, OutboundHttpError, OutboundTimeoutError,
  OwnHostError, RedirectNotAllowedError, RequestTooLargeError, ResponseTooLargeError, UrlNotAllowedError,
} from './errors.js';
import { isSameAddress, parseIpAddress, type IpAddress } from './ipAddress.js';
import { systemResolver, type ResolvedAddress, type Resolver } from './resolver.js';

/** `none`: redirects go back to the caller (forwarding, routing). `sameHost`: follow them on the same host only (OH-3). */
export type RedirectPolicy = 'none' | 'sameHost';
export type OutboundHeaders = Readonly<Record<string, string | readonly string[]>>;
export type OutboundBody = string | Uint8Array | Readable;

// OH-4 forwarding defaults. The response limit matches the x402 buffer limit (AR3).
export const outboundDefaults = {
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 30_000,
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 10 * 1024 * 1024,
  maxRedirects: 5,
} as const;

export interface OutboundHttpOptions {
  // Platform hosts and IP addresses, from platform config. Refused, with their subdomains (OH-5).
  readonly ownHosts: readonly string[];
  readonly connectTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
  readonly resolver?: Resolver;
  // Anything but the public policy is refused when NODE_ENV is production (OH-7)
  readonly addressPolicy?: AddressPolicy;
  // CAs to trust instead of the system's, for test servers
  readonly ca?: string | readonly string[];
  readonly timers?: Timers;
}

export interface OutboundRequest {
  readonly url: string | URL;
  readonly method?: string;
  // A `host` header is dropped: Host and SNI always match the URL (OH-2)
  readonly headers?: OutboundHeaders;
  readonly body?: OutboundBody;
  // Required: every caller picks its redirect policy
  readonly redirect: RedirectPolicy;
  readonly totalTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
}

export interface OutboundResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  // The final URL, after same-host redirects
  readonly url: URL;
  // Fails with ResponseTooLargeError past the limit, and with OutboundTimeoutError at the deadline
  readonly body: Readable;
  bytes(): Promise<Buffer>;
  text(): Promise<string>;
  // Discards the body and frees the connection
  dispose(): void;
}

interface Deadline {
  readonly signal: AbortSignal;
  clear(): void;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

const normalizeHost = (hostname: string): string =>
  hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');

const firstHeader = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : value?.[0];

const chunkLength = (chunk: unknown): number => Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));

const toDispatchHeaders = (headers: OutboundHeaders | undefined, dropContent: boolean): Record<string, string | string[]> =>
  Object.fromEntries(Object.entries(headers ?? {})
    .filter(([name]) => name.toLowerCase() !== 'host' && !(dropContent && name.toLowerCase().startsWith('content-')))
    .map(([name, value]) => [name, typeof value === 'string' ? value : [...value]]));

const limitRequestBody = (host: string, body: OutboundBody | undefined, limit: number): OutboundBody | undefined => {
  if (body === undefined || typeof body === 'string' || body instanceof Uint8Array) {
    const size = body === undefined ? 0 : typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
    if (size > limit)
      throw new RequestTooLargeError(host, limit);

    return body;
  }

  let sent = 0;
  const limited = new Transform({
    transform: (chunk: unknown, _encoding, callback) => {
      sent += chunkLength(chunk);
      if (sent > limit)
        callback(new RequestTooLargeError(host, limit));
      else
        callback(null, chunk);
    },
  });
  body.on('error', error => limited.destroy(error));

  return body.pipe(limited);
};

/**
 * The only way to fetch a URL that someone outside the platform controls (OH-1 to OH-8). Resolves the
 * host, refuses private, special-purpose, and platform addresses, then connects to the checked
 * address without resolving again. HTTPS only, with timeouts and size limits on every call.
 */
export class OutboundHttp {
  readonly #agent: Agent;
  readonly #resolver: Resolver;
  readonly #policy: AddressPolicy;
  readonly #timers: Timers;
  readonly #ownHostnames: readonly string[];
  readonly #ownAddresses: readonly IpAddress[];
  readonly #connectTimeoutMs: number;
  readonly #totalTimeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxRedirects: number;

  constructor(options: OutboundHttpOptions) {
    const policy = options.addressPolicy ?? publicAddressPolicy;
    if (policy !== publicAddressPolicy && process.env['NODE_ENV'] === 'production')
      throw new AddressPolicyNotAllowedError();

    const ownHosts = options.ownHosts.map(normalizeHost);
    this.#policy = policy;
    this.#resolver = options.resolver ?? systemResolver;
    this.#timers = options.timers ?? systemTimers;
    this.#ownAddresses = ownHosts.map(parseIpAddress).filter(address => address !== undefined);
    this.#ownHostnames = ownHosts.filter(host => parseIpAddress(host) === undefined);
    this.#connectTimeoutMs = options.connectTimeoutMs ?? outboundDefaults.connectTimeoutMs;
    this.#totalTimeoutMs = options.totalTimeoutMs ?? outboundDefaults.totalTimeoutMs;
    this.#maxRequestBytes = options.maxRequestBytes ?? outboundDefaults.maxRequestBytes;
    this.#maxResponseBytes = options.maxResponseBytes ?? outboundDefaults.maxResponseBytes;
    this.#maxRedirects = options.maxRedirects ?? outboundDefaults.maxRedirects;

    // Pools and keeps alive connections per origin (OH-8). A pooled connection was checked when it opened.
    this.#agent = new Agent({
      connect: {
        timeout: this.#connectTimeoutMs,
        lookup: this.#lookup,
        ...(options.ca === undefined ? {} : { ca: typeof options.ca === 'string' ? options.ca : [...options.ca] }),
      },
    });
  }

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    request.signal?.throwIfAborted();

    const origin = this.#checkUrl(request.url);
    const host = normalizeHost(origin.hostname);
    const totalTimeoutMs = request.totalTimeoutMs ?? this.#totalTimeoutMs;
    const maxResponseBytes = request.maxResponseBytes ?? this.#maxResponseBytes;
    const deadline = this.#startDeadline(host, totalTimeoutMs, request.signal);

    try {
      let url = origin;
      let method = (request.method ?? 'GET').toUpperCase();
      let dropContentHeaders = false;
      let body = limitRequestBody(host, request.body, request.maxRequestBytes ?? this.#maxRequestBytes);

      for (let redirects = 0; ; redirects += 1) {
        const response = await this.#agent.request({
          origin: url.origin,
          path: `${url.pathname}${url.search}`,
          method: method as Dispatcher.HttpMethod,
          headers: toDispatchHeaders(request.headers, dropContentHeaders),
          body: body ?? null,
          signal: deadline.signal,
        });
        const location = firstHeader(response.headers['location']);
        if (request.redirect === 'none' || !redirectStatuses.has(response.statusCode) || location === undefined)
          return this.#wrapResponse(response, url, host, maxResponseBytes, deadline);

        await response.body.dump();
        if (redirects >= this.#maxRedirects)
          throw new RedirectNotAllowedError(host, `${host} redirected more than ${this.#maxRedirects} times`);

        let next: URL;
        try {
          next = new URL(location, url);
        }
        catch {
          throw new RedirectNotAllowedError(host, `${host} redirected to an invalid URL`);
        }
        if (next.protocol !== 'https:' || next.host !== origin.host)
          throw new RedirectNotAllowedError(host, `${host} redirected to another host or to plain HTTP`);
        url = this.#checkUrl(next);

        // As browsers do: 303, and 301 or 302 after a POST, continue as GET without a body
        const switchToGet = response.statusCode === 303
          ? method !== 'GET' && method !== 'HEAD'
          : (response.statusCode === 301 || response.statusCode === 302) && method === 'POST';
        if (switchToGet) {
          method = 'GET';
          body = undefined;
          dropContentHeaders = true;
        }
        else if (body instanceof Readable)
          throw new RedirectNotAllowedError(host, `${host} redirected a request whose body can't be sent again`);
      }
    }
    catch (error) {
      deadline.clear();
      throw this.#toOutboundError(error, host, deadline.signal);
    }
  }

  /** Closes pooled connections. Call on shutdown. */
  async close(): Promise<void> {
    await this.#agent.close();
  }

  // Called by the socket on every new connection: the one place a hostname becomes an address
  readonly #lookup: LookupFunction = (hostname: string, options: LookupOptions, callback: LookupCallback) => {
    this.#resolveChecked(hostname).then(addresses => {
      const family = options.family === 4 || options.family === 'IPv4' ? 4 : options.family === 6 || options.family === 'IPv6' ? 6 : undefined;
      const usable = family === undefined ? addresses : addresses.filter(address => address.family === family);
      const [first] = usable;
      if (!first)
        callback(new DnsLookupError(normalizeHost(hostname)), '');
      else if (options.all)
        callback(null, usable.map(({ address, family: addressFamily }) => ({ address, family: addressFamily })));
      else
        callback(null, first.address, first.family);
    }, (error: unknown) => callback(error as NodeJS.ErrnoException, ''));
  };

  async #resolveChecked(hostname: string): Promise<readonly ResolvedAddress[]> {
    const host = normalizeHost(hostname);
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.#resolver.resolve(host);
    }
    catch (error) {
      throw new DnsLookupError(host, { cause: error });
    }
    if (addresses.length === 0)
      throw new DnsLookupError(host);

    // Every address must pass: an answer that mixes public and private addresses is refused whole
    for (const { address } of addresses)
      this.#checkAddress(host, address);

    return addresses;
  }

  #checkAddress(host: string, address: string): void {
    const parsed = parseIpAddress(address);
    if (parsed && this.#ownAddresses.some(ownAddress => isSameAddress(ownAddress, parsed)))
      throw new OwnHostError(host);

    const reason = this.#policy.refuse(address);
    if (reason !== undefined)
      throw new BlockedAddressError(host, address, reason);
  }

  #checkUrl(input: string | URL): URL {
    let url: URL;
    try {
      url = new URL(input);
    }
    catch {
      throw new UrlNotAllowedError('', 'The URL is not valid');
    }

    const host = normalizeHost(url.hostname);
    if (url.protocol !== 'https:')
      throw new UrlNotAllowedError(host, `Only HTTPS URLs are allowed, not ${url.protocol.slice(0, -1)}`);
    if (url.username || url.password)
      throw new UrlNotAllowedError(host, 'URLs must not carry credentials');
    if (this.#ownHostnames.some(ownHost => host === ownHost || host.endsWith(`.${ownHost}`)))
      throw new OwnHostError(host);
    // The socket skips the lookup for an IP address, so check it here
    if (parseIpAddress(host))
      this.#checkAddress(host, host);

    return url;
  }

  #startDeadline(host: string, timeoutMs: number, callerSignal: AbortSignal | undefined): Deadline {
    const controller = new AbortController();
    const handle = this.#timers.setTimeout(() => controller.abort(new OutboundTimeoutError(host, 'total', timeoutMs)), timeoutMs);
    const onAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', onAbort, { once: true });

    return {
      signal: controller.signal,
      clear: () => {
        this.#timers.clearTimeout(handle);
        callerSignal?.removeEventListener('abort', onAbort);
      },
    };
  }

  #wrapResponse(response: Dispatcher.ResponseData, url: URL, host: string, limit: number, deadline: Deadline): OutboundResponse {
    const declaredLength = Number(firstHeader(response.headers['content-length']));
    if (declaredLength > limit) {
      // undici reports a destroyed body as an error; unheard, it would crash the process
      response.body.on('error', () => undefined).destroy();
      throw new ResponseTooLargeError(host, limit);
    }

    let received = 0;
    const body = new Transform({
      transform: (chunk: unknown, _encoding, callback) => {
        received += chunkLength(chunk);
        if (received > limit)
          callback(new ResponseTooLargeError(host, limit));
        else
          callback(null, chunk);
      },
    });
    response.body.on('error', error => body.destroy(this.#toOutboundError(error, host, deadline.signal) as Error));
    body.on('close', () => {
      deadline.clear();
      response.body.destroy();
    });
    response.body.pipe(body);

    const bytes = async (): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      for await (const chunk of body)
        chunks.push(Buffer.from(chunk as Uint8Array));

      return Buffer.concat(chunks);
    };

    return {
      status: response.statusCode,
      headers: response.headers,
      url,
      body,
      bytes,
      text: async () => (await bytes()).toString('utf8'),
      dispose: () => body.destroy(),
    };
  }

  #toOutboundError(error: unknown, host: string, signal: AbortSignal): unknown {
    if (error instanceof OutboundHttpError)
      return error;
    // The deadline's OutboundTimeoutError, or the caller's own abort reason
    if (signal.aborted)
      return signal.reason;

    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof OutboundHttpError)
      return cause;

    const code = (error as { readonly code?: unknown } | null)?.code;
    if (code === 'UND_ERR_CONNECT_TIMEOUT')
      return new OutboundTimeoutError(host, 'connect', this.#connectTimeoutMs);
    // A caller bug, such as a forbidden header; not a network failure
    if (code === 'UND_ERR_INVALID_ARG')
      return error;

    return new ConnectionFailedError(host, { cause: error });
  }
}
