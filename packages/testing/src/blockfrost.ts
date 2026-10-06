import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import * as PrivateKey from '@evolution-sdk/evolution/PrivateKey';
import * as Transaction from '@evolution-sdk/evolution/Transaction';
import * as TransactionBody from '@evolution-sdk/evolution/TransactionBody';
import * as TransactionHash from '@evolution-sdk/evolution/TransactionHash';
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
  /**
   * A transaction in the block at the chain's tip that pays each output, for the deposit watcher
   * (DP-2): it shows in the addresses' transactions and in `/txs/<hash>/utxos`. Returns its hash.
   */
  send(outputs: readonly { readonly address: string; readonly value: FundedValue }[]): string;
  /** The chain grows by this many blocks. */
  addBlocks(count: number): void;
  /** A re-org drops the transaction: Blockfrost no longer knows it. */
  dropTransaction(txHash: string): void;
  /** Every transaction submitted to `/tx/submit`, by hash, with its CBOR in hex. */
  readonly submitted: ReadonlyMap<string, string>;
  /** Each accepted submission's hash, in order, repeats included. */
  readonly submissions: readonly string[];
  /**
   * What `/tx/submit` does next: `include` (the default) puts the transaction in the block at the tip,
   * `hold` accepts it but never includes it, `reject` answers 400, as for spent inputs, `lose` answers
   * 503 without taking it, and `include_then_fail` takes and includes it but answers 503, as when the
   * answer times out after the node accepted it.
   */
  onSubmit(mode: SubmitMode): void;
  /** Puts a held transaction in the block at the tip, as when it leaves the mempool. */
  include(txHash: string): void;
  readonly tipHeight: number;
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

export type SubmitMode = 'include' | 'hold' | 'reject' | 'lose' | 'include_then_fail';

interface ChainTransaction {
  readonly hash: string;
  readonly blockHeight: number;
  readonly outputs: readonly { readonly address: string; readonly amount: readonly { readonly unit: string; readonly quantity: string }[] }[];
}

// Blockfrost writes a native asset's unit as the policy ID and asset name, joined
const amountsOf = ({ lovelace, assets = {} }: FundedValue) => [
  { unit: 'lovelace', quantity: lovelace.toString() },
  ...Object.entries(assets).map(([asset, quantity]) => ({ unit: asset.replace('.', ''), quantity: quantity.toString() })),
];

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
  const transactions = new Map<string, ChainTransaction>();
  let tipHeight = 1_000;
  const submitted = new Map<string, string>();
  const submissions: string[] = [];
  let submitMode: SubmitMode = 'include';
  const notFound = (response: ServerResponse) => send(response, 404, { status_code: 404, error: 'Not Found', message: 'The requested component has not been found.' });

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '/';
    const projectId = request.headers['project_id'];
    requests.push({ method: request.method ?? '', path, projectId: typeof projectId === 'string' ? projectId : undefined });
    const url = new URL(path, 'http://blockfrost');
    if (request.method === 'GET' && url.pathname === '/epochs/latest/parameters')
      return send(response, 200, protocolParameters);

    if (request.method === 'POST' && url.pathname === '/tx/submit') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (submitMode === 'reject')
          return send(response, 400, { status_code: 400, error: 'Bad Request', message: 'The transaction is invalid' });
        if (submitMode === 'lose')
          return send(response, 503, { status_code: 503, error: 'Service Unavailable', message: 'Try again' });

        const cbor = Buffer.concat(chunks).toString('hex');
        const hash = TransactionHash.toHex(TransactionBody.toHash(Transaction.fromCBORHex(cbor).body));
        // On chain already: its inputs are spent, so the node refuses it again, as a real node does
        if (transactions.has(hash))
          return send(response, 400, { status_code: 400, error: 'Bad Request', message: 'BadInputsUTxO' });
        submitted.set(hash, cbor);
        submissions.push(hash);
        if (submitMode !== 'hold' && !transactions.has(hash))
          transactions.set(hash, { hash, blockHeight: tipHeight, outputs: [] });
        if (submitMode === 'include_then_fail')
          return send(response, 503, { status_code: 503, error: 'Service Unavailable', message: 'Try again' });
        send(response, 200, hash);
      });
      return;
    }

    const balance = /^\/addresses\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && balance) {
      const address = decodeURIComponent(balance[1]!);
      const held = utxos.get(address);
      if (!held)
        return notFound(response);
      const totals = new Map<string, bigint>();
      for (const utxo of held) {
        for (const amount of utxo.amount)
          totals.set(amount.unit, (totals.get(amount.unit) ?? 0n) + BigInt(amount.quantity));
      }

      return send(response, 200, { address, amount: [...totals].map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })) });
    }

    if (request.method === 'GET' && url.pathname === '/blocks/latest')
      return send(response, 200, { height: tipHeight, slot: tipHeight * 20, time: 1_791_287_400 + tipHeight * 20 });

    const history = /^\/addresses\/([^/]+)\/transactions$/.exec(url.pathname);
    if (request.method === 'GET' && history) {
      const address = decodeURIComponent(history[1]!);
      const from = Number(url.searchParams.get('from') ?? '0');
      const count = Number(url.searchParams.get('count') ?? '100');
      const page = Number(url.searchParams.get('page') ?? '1');
      const items = [...transactions.values()]
        .filter(transaction => transaction.blockHeight >= from && transaction.outputs.some(output => output.address === address))
        .sort((a, b) => a.blockHeight - b.blockHeight)
        .map(transaction => ({ tx_hash: transaction.hash, tx_index: 0, block_height: transaction.blockHeight, block_time: 1_791_287_400 + transaction.blockHeight * 20 }));
      // An address the chain never saw is a 404, as on Blockfrost
      if (items.length === 0 && ![...transactions.values()].some(transaction => transaction.outputs.some(output => output.address === address)))
        return notFound(response);

      return send(response, 200, items.slice((page - 1) * count, page * count));
    }

    const transactionUtxos = /^\/txs\/([0-9a-f]{64})\/utxos$/.exec(url.pathname);
    if (request.method === 'GET' && transactionUtxos) {
      const transaction = transactions.get(transactionUtxos[1]!);
      if (!transaction)
        return notFound(response);

      return send(response, 200, {
        hash: transaction.hash,
        inputs: [],
        outputs: transaction.outputs.map((output, index) => ({ address: output.address, amount: output.amount, output_index: index, data_hash: null })),
      });
    }

    const transactionInfo = /^\/txs\/([0-9a-f]{64})$/.exec(url.pathname);
    if (request.method === 'GET' && transactionInfo) {
      const transaction = transactions.get(transactionInfo[1]!);

      return transaction ? send(response, 200, { hash: transaction.hash, block_height: transaction.blockHeight }) : notFound(response);
    }

    const owned = /^\/addresses\/([^/]+)\/utxos$/.exec(url.pathname);
    if (request.method === 'GET' && owned) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const all = utxos.get(decodeURIComponent(owned[1]!)) ?? [];

      return send(response, 200, page === 1 ? all : []);
    }

    notFound(response);
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
        amount: amountsOf({ lovelace, assets }),
        block: randomBytes(32).toString('hex'),
        data_hash: null,
        inline_datum: null,
        reference_script_hash: null,
      });
      utxos.set(address, owned);

      return `${transaction}#0`;
    },
    send: outputs => {
      const hash = randomBytes(32).toString('hex');
      transactions.set(hash, { hash, blockHeight: tipHeight, outputs: outputs.map(({ address, value }) => ({ address, amount: amountsOf(value) })) });

      return hash;
    },
    addBlocks: count => {
      tipHeight += count;
    },
    dropTransaction: txHash => {
      transactions.delete(txHash);
    },
    submitted,
    submissions,
    onSubmit: mode => {
      submitMode = mode;
    },
    include: txHash => {
      if (!transactions.has(txHash))
        transactions.set(txHash, { hash: txHash, blockHeight: tipHeight, outputs: [] });
    },
    get tipHeight() {
      return tipHeight;
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
