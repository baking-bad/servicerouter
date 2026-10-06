import { readFileSync } from 'node:fs';

// The fixture files sit next to src/ and dist/, so both resolve them the same way
const nownodesFixture = new URL('../fixtures/nownodes/service.yaml', import.meta.url);

/** The upstream hosts of the NOWNodes fixture, for a fake upstream's certificate and a fake resolver. */
export const nownodesHosts = ['eth.nownodes.io', 'base.nownodes.io', 'sol.nownodes.io', 'btcbook.nownodes.io'] as const;

/** The secrets the NOWNodes fixture uses: one per host (SC-10). */
export const nownodesSecretNames = ['nownodes-eth-api-key', 'nownodes-base-api-key', 'nownodes-sol-api-key', 'nownodes-btc-api-key'] as const;

/** The category the NOWNodes fixture uses. Add it to a test's platform config. */
export const nownodesCategory = { id: 'blockchain', title: 'Blockchain' } as const;

/**
 * A multi-chain upstream configuration fixture, as YAML text. With
 * `port`, every upstream points at that port on its host, such as a fake upstream's.
 */
export const nownodesServiceConfig = ({ port }: { readonly port?: number } = {}): string => {
  const text = readFileSync(nownodesFixture, 'utf8');

  return port === undefined ? text : text.replace(/baseUrl: https:\/\/([a-z]+\.nownodes\.io)/g, `baseUrl: https://$1:${port}`);
};
