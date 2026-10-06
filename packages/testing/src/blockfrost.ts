import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import * as PrivateKey from '@evolution-sdk/evolution/PrivateKey';
import { toClientCardanoSigner, type ClientCardanoSigner } from '@x402/cardano';

export interface BlockfrostRequest {
  readonly method: string;
  // Path and query, as received
  readonly path: string;
  readonly projectId: string | undefined;
}

/** What a funded UTxO holds: lovelace, and native assets by `<policy ID>.<asset name hex>`. */
export interface FundedValue {
  readonly lovelace: bigint;
  readonly assets?: Readonly<Record<string, bigint>>;
}

export interface FakeBlockfrost {
  // The base URL, as `https://cardano-preprod.blockfrost.io/api/v0` would be
  readonly url: string;
  readonly requests: readonly BlockfrostRequest[];
  /** Gives an address one more UTxO. Returns its reference, `<transaction hash>#<index>`. */
  fund(address: string, value: FundedValue): string;
  close(): Promise<void>;
}

// Preprod's protocol parameters in the Conway era. Prices are strings, as Blockfrost writes them
const protocolParameters = {
  min_fee_a: 44,
  min_fee_b: 155381,
  key_deposit: 2000000,
  pool_deposit: 500000000,
  max_tx_size: 16384,
  max_val_size: 5000,
  max_block_size: 90112,
  coins_per_utxo_size: 4310,
  price_mem: '0.0577',
  price_step: '0.0000721',
  max_tx_ex_mem: 14000000,
  max_tx_ex_steps: 10000000000,
  collateral_percent: 150,
  max_collateral_inputs: 3,
  min_fee_ref_script_cost_per_byte: '15',
  drep_deposit: 500000000,
  gov_action_deposit: 100000000000,
};

interface Utxo {
  readonly address: string;
  readonly tx_hash: string;
  readonly tx_index: number;
  readonly output_index: number;
  readonly amount: readonly { readonly unit: string; readonly quantity: string }[];
  readonly block: string;
  readonly data_hash: null;
  readonly inline_datum: null;
  readonly reference_script_hash: null;
}

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

/**
 * A fake Blockfrost on 127.0.0.1 with what a Cardano wallet needs to build a payment: the latest
 * protocol parameters, and the UTxOs `fund` gave each address. Every other path answers `404`, as
 * Blockfrost does for what it can't find. Records every request.
 */
export const startFakeBlockfrost = async (): Promise<FakeBlockfrost> => {
  const requests: BlockfrostRequest[] = [];
  const utxos = new Map<string, Utxo[]>();

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '/';
    const projectId = request.headers['project_id'];
    requests.push({ method: request.method ?? '', path, projectId: typeof projectId === 'string' ? projectId : undefined });
    const url = new URL(path, 'http://blockfrost');
    if (request.method === 'GET' && url.pathname === '/epochs/latest/parameters')
      return send(response, 200, protocolParameters);

    const owned = /^\/addresses\/([^/]+)\/utxos$/.exec(url.pathname);
    if (request.method === 'GET' && owned) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const all = utxos.get(decodeURIComponent(owned[1]!)) ?? [];

      return send(response, 200, page === 1 ? all : []);
    }

    send(response, 404, { status_code: 404, error: 'Not Found', message: 'The requested component has not been found.' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    fund: (address, { lovelace, assets = {} }) => {
      const transaction = randomBytes(32).toString('hex');
      const owned = utxos.get(address) ?? [];
      owned.push({
        address,
        tx_hash: transaction,
        tx_index: 0,
        output_index: 0,
        // Blockfrost writes a native asset's unit as the policy ID and asset name, joined
        amount: [{ unit: 'lovelace', quantity: lovelace.toString() }, ...Object.entries(assets).map(([asset, quantity]) => ({ unit: asset.replace('.', ''), quantity: quantity.toString() }))],
        block: randomBytes(32).toString('hex'),
        data_hash: null,
        inline_datum: null,
        reference_script_hash: null,
      });
      utxos.set(address, owned);

      return `${transaction}#0`;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
};

export interface TestCardanoWallet {
  // The payer's bech32 address
  readonly address: string;
  // For `@x402/cardano`'s client scheme: builds and signs a payment, never broadcasts it
  readonly signer: ClientCardanoSigner;
}

export interface TestCardanoWalletOptions {
  // An x402 Cardano network, such as `cardano:preprod`
  readonly network: string;
  // Where the wallet reads its UTxOs and the protocol parameters
  readonly blockfrost: Pick<FakeBlockfrost, 'url'>;
}

/** A Cardano wallet made for the test, on `@x402/cardano`'s reference client signer, reading a fake Blockfrost. */
export const createTestCardanoWallet = ({ network, blockfrost }: TestCardanoWalletOptions): TestCardanoWallet => {
  const signer = toClientCardanoSigner({
    mnemonic: PrivateKey.generateMnemonic(256),
    network,
    provider: { blockfrost: { baseUrl: blockfrost.url, projectId: 'test' } },
  });

  return { address: signer.getAddress(), signer };
};
