import { lookup } from 'node:dns/promises';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Resolves a hostname to every address it has. Injected, so tests can use a fake DNS (OH-7). */
export interface Resolver {
  resolve(hostname: string): Promise<readonly ResolvedAddress[]>;
}

export const systemResolver: Resolver = {
  resolve: async hostname => (await lookup(hostname, { all: true, order: 'verbatim' }))
    .map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 })),
};
