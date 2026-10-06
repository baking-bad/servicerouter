import type { IncomingHttpHeaders } from 'node:http';

import { formatUsd, withTimeout, type Logger, type MicroUsd, type OutboundHeaders, type OutboundHttp, type Secret } from '@servicerouter/common';
import { createOwnershipFileFetcher, type PlatformConfig } from '@servicerouter/core';
import type { Redis } from '@servicerouter/db';
import type { PaymentRequirements } from '@x402/core/types';

import { forwardedRequestHeaders } from '../services/forward.js';

/** The Signer can't be reached, or refused: the buyer pays nothing (SG-4, SG-6). */
export class SignerUnavailableError extends Error {}

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

export interface SignerClient {
  sign(input: {
    readonly requestId: string;
    readonly quoteId: string;
    readonly x402Version: number;
    readonly requirement: PaymentRequirements;
    readonly resource: unknown;
    readonly url: string;
    readonly quotedPrice: MicroUsd;
  }): Promise<SignedPayment>;
}

/** The Signer's internal API (SG-2), with its shared secret. Any failure is SignerUnavailableError. */
export const createSignerClient = ({ url, secret, timeoutMs, fetch = globalThis.fetch }: {
  readonly url: string;
  readonly secret: Secret;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}): SignerClient => ({
  sign: async input => {
    let response: Response;
    try {
      response = await fetch(`${url.replace(/\/+$/, '')}/internal/v1/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signer-secret': secret.expose(), 'x-request-id': input.requestId },
        body: JSON.stringify({ ...input, quotedPrice: input.quotedPrice.toString() }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    catch (error) {
      throw new SignerUnavailableError('The Signer didn\'t answer', { cause: error });
    }
    if (!response.ok) {
      const reason = await response.text().catch(() => '');
      throw new SignerUnavailableError(`The Signer answered ${response.status}: ${reason.slice(0, 200)}`);
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

  return async (host: string): Promise<boolean> => {
    const key = `${redis.prefix}optout:${host}`;
    try {
      const cached = await redis.client.get(key);
      if (cached !== null)
        return cached === '1';
    }
    catch (error) {
      logger.warn({ error, host }, 'The opt-out cache is unavailable');
    }
    let optedOut = false;
    try {
      const result = await withTimeout(() => fetchFile(host), { timeoutMs: optOutTimeoutMs });
      optedOut = result.ok && result.file.routing === false;
    }
    catch {
      // No answer: no opt-out
    }
    try {
      await redis.client.set(key, optedOut ? '1' : '0', { expiration: { type: 'EX', value: optOutTtlSeconds } });
    }
    catch (error) {
      logger.warn({ error, host }, 'Failed to cache an opt-out');
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
  const queue: { host: string; path: string; quote?: string }[] = [];
  let running = false;

  const drain = async (): Promise<void> => {
    if (running)
      return;
    running = true;
    try {
      while (queue.length > 0) {
        const endpoint = queue.shift()!;
        try {
          await fetch(`${url!.replace(/\/+$/, '')}/internal/v1/routed-endpoints`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'x-internal-secret': secret!.expose(), 'x-internal-caller': 'proxy' },
            body: JSON.stringify(endpoint),
            signal: AbortSignal.timeout(5_000),
          });
        }
        catch (error) {
          seen.delete(`${endpoint.host}${endpoint.path}`);
          logger.warn({ error, host: endpoint.host }, 'Failed to register a routed endpoint: the next call registers it');
        }
      }
    }
    finally {
      running = false;
    }
  };

  return {
    register: (host: string, path: string, quote?: MicroUsd): void => {
      if (!url || !secret)
        return;
      const key = `${host}${path}`;
      if (seen.has(key) || queue.length >= capacity)
        return;
      seen.add(key);
      queue.push({ host, path, ...quote === undefined ? {} : { quote: formatUsd(quote) } });
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
