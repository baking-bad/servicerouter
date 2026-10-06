import type { FastifyReply, FastifyRequest } from 'fastify';

import { parseIpAddress, unmapIpv4 } from '@servicerouter/common';
import { RateLimitedError, type RateLimit, type RateLimiter } from '@servicerouter/core';

export interface SignupLimitOptions {
  readonly limiter: RateLimiter;
  readonly limit: RateLimit;
}

/**
 * The client a limit counts: an IPv4 address, or the /64 of an IPv6 address, since one subscriber
 * usually holds a whole /64.
 */
export const clientOf = (ip: string): string => {
  const parsed = parseIpAddress(ip);
  if (!parsed)
    return ip;

  const address = unmapIpv4(parsed);
  if (address.version === 4)
    return address.bytes.join('.');

  const words = Array.from({ length: 4 }, (_, index) => ((address.bytes[index * 2]! << 8) | address.bytes[index * 2 + 1]!).toString(16));

  return `${words.join(':')}::/64`;
};

/**
 * An `onRequest` hook for an endpoint that needs no key: a fixed window per client IP, under
 * `rl:api:<name>:<ip>` (PA-5). Over the limit: `429 rate_limited` with `Retry-After`.
 */
export const createIpLimit = ({ limiter, limit, name }: SignupLimitOptions & { readonly name: string }) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { allowed, retryAfterSeconds } = await limiter.hit(`api:${name}:${clientOf(request.ip)}`, limit);
    if (allowed)
      return;

    reply.header('retry-after', String(retryAfterSeconds));
    throw new RateLimitedError(retryAfterSeconds);
  };

/** The `onRequest` hook for `POST /v1/accounts`, under `rl:api:signup:<ip>` (PA-5). */
export const createSignupLimit = (options: SignupLimitOptions) => createIpLimit({ ...options, name: 'signup' });
