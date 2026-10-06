import type { IncomingHttpHeaders } from 'node:http';

import {
  formatUsd, isRecord, outboundErrorCode, outboundFields, withTimeout, type Logger, type LogSink, type MicroUsd, type OutboundHeaders, type OutboundHttp,
  type Secret,
} from '@servicerouter/common';
import { createOwnershipFileFetcher, type PlatformConfig } from '@servicerouter/core';
import type { Redis } from '@servicerouter/db';
import type { PaymentRequirements } from '@x402/core/types';

import { forwardedRequestHeaders } from '../services/forward.js';

/** What a log line says about a Signer call that failed (L-4, L-5). */
export interface SignerFailure {
  readonly host: string;
  readonly method: 'POST';
  readonly path: string;
  // The Signer's answer, when there was one
  readonly status?: number;
  // `signing_refused` with the Signer's reason, or the transport's error code, such as `ECONNREFUSED`
  readonly code?: string;
  readonly reason?: string;
  readonly durationMs: number;
}

/** The Signer can't be reached, or refused: the buyer pays nothing (SG-4, SG-6). */
export class SignerUnavailableError extends Error {
  readonly failure: SignerFailure | undefined;

  constructor(message: string, options?: ErrorOptions & { readonly failure?: SignerFailure }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });

    this.failure = options?.failure;
  }
}

const signPath = '/internal/v1/sign';

// The Signer's error envelope: its code and reason, never anything else of the body
const refusalOf = async (response: Response): Promise<{ readonly code?: string; readonly reason?: string }> => {
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body['error']) ? body['error'] : undefined;
    const code = typeof error?.['code'] === 'string' ? error['code'].slice(0, 64) : undefined;
    const reason = typeof error?.['message'] === 'string' ? error['message'].split('\n', 1)[0]!.slice(0, 200) : undefined;

    return { ...code === undefined ? {} : { code }, ...reason === undefined ? {} : { reason } };
  }
  catch {
    return {};
  }
};

/** What the Signer gives back for a target payment (SG-2). */
export interface SignedPayment {
  readonly header: string;
  readonly signatureId: string;
  readonly network: string;
  readonly asset: string;
  readonly atomicAmount: bigint;
  readonly amount: MicroUsd;
  readonly payTo: string;
}

/** What the Signer pays (SG-2): the chosen x402 option, or the target's MPP challenge as it sent it. */
export type SignInput = {
  readonly requestId: string;
  readonly quoteId: string;
  readonly url: string;
  readonly quotedPrice: MicroUsd;
} & ({
  readonly protocol: 'x402';
  readonly x402Version: number;
  readonly requirement: PaymentRequirements;
  readonly resource: unknown;
} | {
  readonly protocol: 'mpp';
  readonly challenge: string;
});

export interface SignerClient {
  /** The PAYMENT-SIGNATURE value for x402, or the Authorization value for MPP. */
  sign(input: SignInput): Promise<SignedPayment>;
}

/** The Signer's internal API (SG-2), with its shared secret. Any failure is SignerUnavailableError. */
export const createSignerClient = ({ url, secret, timeoutMs, fetch = globalThis.fetch }: {
  readonly url: string;
  readonly secret: Secret;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}): SignerClient => ({
  sign: async input => {
    const target = `${url.replace(/\/+$/, '')}${signPath}`;
    const started = performance.now();
    const failure = (extra: Pick<SignerFailure, 'status' | 'code' | 'reason'>): SignerFailure => {
      const { host, path } = outboundFields({ url: target, method: 'POST' });

      return { host: String(host), method: 'POST', path: String(path), ...extra, durationMs: Math.round(performance.now() - started) };
    };
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        // The request ID goes along, so one ID finds the call in both apps' logs (XC-5, L-2)
        headers: { 'content-type': 'application/json', 'x-signer-secret': secret.expose(), 'x-request-id': input.requestId },
        body: JSON.stringify({ ...input, quotedPrice: input.quotedPrice.toString() }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    catch (error) {
      const code = outboundErrorCode(error);
      throw new SignerUnavailableError('The Signer didn\'t answer', { cause: error, failure: failure(code === undefined ? {} : { code }) });
    }
    if (!response.ok) {
      // A 422 signing_refused says why (L-5): its code and reason, never the rest of the body
      const refusal = await refusalOf(response);
      throw new SignerUnavailableError(`The Signer answered ${response.status}${refusal.code ? ` ${refusal.code}` : ''}`, { failure: failure({ status: response.status, ...refusal }) });
    }
    const body = await response.json() as Record<string, string>;

    return {
      header: body['header']!,
      signatureId: body['signatureId']!,
      network: body['network']!,
      asset: body['asset']!,
      atomicAmount: BigInt(body['atomicAmount']!),
      amount: BigInt(body['amount']!) as MicroUsd,
      payTo: body['payTo']!,
    };
  },
});

// RT-16: never Authorization or Cookie. The proxy's allowlist, plus a buyer's own `X-…` headers, such as
// `X-Api-Key` for the target (AR15), but none of ours or the payment protocols'.
const reservedXHeaders = /^x-(?:forwarded|real-ip|request-id|internal|signer|payment)/;

/** The headers a routed request sends the target (RT-16). */
export const routedRequestHeaders = (headers: IncomingHttpHeaders, requestId: string): Record<string, string | readonly string[]> => {
  const result: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === 'content-length')
      continue;
    if (forwardedRequestHeaders.has(name) || (name.startsWith('x-') && !reservedXHeaders.test(name)))
      result[name] = value;
  }
  result['x-request-id'] = requestId;

  return result;
};

/** The base domains the platform owns: its URLs' hosts and every subdomain of their registrable domain (RT-2). */
export const ownDomainsOf = (config: PlatformConfig): readonly string[] => {
  const domains = new Set<string>();
  for (const url of Object.values(config.urls)) {
    const labels = new URL(url).hostname.split('.');
    domains.add(labels.slice(-2).join('.'));
  }
  for (const host of config.ownHosts)
    domains.add(host);

  return [...domains];
};

export const isOwnHost = (hostname: string, domains: readonly string[]): boolean =>
  domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));

// RT-2: the opt-out is cached a day per host, in Redis under `optout:`
const optOutTtlSeconds = 24 * 60 * 60;
const optOutTimeoutMs = 2_000;

/**
 * Whether a host opted out of routing with `routing: false` in its ownership file (RT-2, OV-8). Cached a
 * day. A failed fetch means no opt-out.
 */
export const createOptOutCheck = ({ http, redis, logger, fileUrl }: {
  readonly http: Pick<OutboundHttp, 'request'>;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly fileUrl?: (host: string) => string;
}) => {
  const fetchFile = createOwnershipFileFetcher({ http, ...fileUrl ? { fileUrl } : {} });

  // `log`: the request's logger, so its lines carry the request ID
  return async (host: string, log: LogSink = logger): Promise<boolean> => {
    const key = `${redis.prefix}optout:${host}`;
    try {
      const cached = await redis.client.get(key);
      if (cached !== null)
        return cached === '1';
    }
    catch (error) {
      log.warn({ error, host }, 'The opt-out cache is unavailable');
    }
    let optedOut = false;
    try {
      const result = await withTimeout(() => fetchFile(host), { timeoutMs: optOutTimeoutMs });
      optedOut = result.ok && result.file.routing === false;
      // Most hosts have no file: that is no opt-out. A file that can't be read is too, and says why (L-4).
      if (!result.ok)
        log[result.problem === 'file_not_found' ? 'debug' : 'info']({ ...result.outbound, host, problem: result.problem }, 'The routing opt-out file couldn\'t be read: no opt-out');
    }
    catch (error) {
      // No answer in time: no opt-out
      log.info({ host, code: outboundErrorCode(error) ?? 'timeout', timeoutMs: optOutTimeoutMs }, 'The routing opt-out file didn\'t arrive in time: no opt-out');
    }
    try {
      await redis.client.set(key, optedOut ? '1' : '0', { expiration: { type: 'EX', value: optOutTtlSeconds } });
    }
    catch (error) {
      log.warn({ error, host }, 'Failed to cache an opt-out');
    }

    return optedOut;
  };
};

/** RT-12: registers routed endpoints off the hot path, through the internal API. A lost one is fine. */
export const createEndpointRegistrar = ({ url, secret, logger, fetch = globalThis.fetch, capacity = 1_000 }: {
  readonly url: string | undefined;
  readonly secret: Secret | undefined;
  readonly logger: Logger;
  readonly fetch?: typeof globalThis.fetch;
  readonly capacity?: number;
}) => {
  const seen = new Set<string>();
  const queue: { readonly endpoint: { host: string; path: string; quote?: string }; readonly requestId: string | undefined }[] = [];
  let running = false;

  const drain = async (): Promise<void> => {
    if (running)
      return;
    running = true;
    try {
      while (queue.length > 0) {
        const { endpoint, requestId } = queue.shift()!;
        const target = `${url!.replace(/\/+$/, '')}/internal/v1/routed-endpoints`;
        const started = performance.now();
        // The routed call's request ID goes along, so the internal API's lines carry it too (XC-5, L-2)
        const failed = (outcome: { readonly status?: number; readonly error?: unknown }, message: string): void => {
          logger.warn({
            ...outboundFields({ url: target, method: 'PUT', ...outcome, durationMs: performance.now() - started }),
            ...requestId === undefined ? {} : { requestId }, endpointHost: endpoint.host, ...outcome.error === undefined ? {} : { error: outcome.error },
          }, message);
        };
        try {
          const response = await fetch(target, {
            method: 'PUT',
            headers: {
              'content-type': 'application/json', 'x-internal-secret': secret!.expose(), 'x-internal-caller': 'proxy',
              ...requestId === undefined ? {} : { 'x-request-id': requestId },
            },
            body: JSON.stringify(endpoint),
            signal: AbortSignal.timeout(5_000),
          });
          await response.body?.cancel();
          if (!response.ok)
            failed({ status: response.status }, 'The internal API refused to register a routed endpoint');
        }
        catch (error) {
          seen.delete(`${endpoint.host}${endpoint.path}`);
          failed({ error }, 'Failed to register a routed endpoint: the next call registers it');
        }
      }
    }
    finally {
      running = false;
    }
  };

  return {
    register: (host: string, path: string, quote?: MicroUsd, requestId?: string): void => {
      if (!url || !secret)
        return;
      const key = `${host}${path}`;
      if (seen.has(key) || queue.length >= capacity)
        return;
      seen.add(key);
      queue.push({ endpoint: { host, path, ...quote === undefined ? {} : { quote: formatUsd(quote) } }, requestId });
      void drain();
    },
    /** For tests and shutdown: waits until the queue is empty. */
    settled: async (): Promise<void> => {
      while (queue.length > 0 || running)
        await new Promise(resolve => setTimeout(resolve, 5));
    },
  };
};

export type EndpointRegistrar = ReturnType<typeof createEndpointRegistrar>;

export type ForwardHeaders = OutboundHeaders;
