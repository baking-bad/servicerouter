import { isIP } from 'node:net';

import type { ResolvedAddress, Resolver } from '@servicerouter/common';

export interface FakeResolver extends Resolver {
  // Every hostname looked up, in order
  readonly lookups: readonly string[];
  set(hostname: string, addresses: string | readonly string[]): void;
}

/** A DNS resolver that answers from a table. Unknown names fail like getaddrinfo's ENOTFOUND. */
export const createFakeResolver = (records: Readonly<Record<string, string | readonly string[]>> = {}): FakeResolver => {
  const table = new Map<string, readonly string[]>();
  const lookups: string[] = [];
  const set = (hostname: string, addresses: string | readonly string[]) =>
    table.set(hostname.toLowerCase(), typeof addresses === 'string' ? [addresses] : addresses);
  for (const [hostname, addresses] of Object.entries(records))
    set(hostname, addresses);

  return {
    lookups,
    set,
    resolve: async hostname => {
      lookups.push(hostname);
      const addresses = table.get(hostname.toLowerCase());
      if (!addresses)
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });

      return addresses.map((address): ResolvedAddress => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
    },
  };
};
