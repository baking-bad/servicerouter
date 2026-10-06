import { isRecord, ServiceRouterError, type Secret } from '@servicerouter/common';

/** What a log line says about a failed Blockfrost call (L-4): the path without its query, the status, the duration. */
export interface BlockfrostCall {
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly durationMs?: number;
}

/** Blockfrost didn't answer, or answered something unexpected. The message names the call, never the key. */
export class BlockfrostError extends ServiceRouterError {
  readonly code = 'blockfrost_unavailable';
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly status: number | undefined;
  readonly durationMs: number | undefined;

  constructor(message: string, options?: ErrorOptions & BlockfrostCall) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });

    this.method = options?.method;
    this.path = options?.path?.split('?', 1)[0];
    this.status = options?.status;
    this.durationMs = options?.durationMs === undefined ? undefined : Math.round(options.durationMs);
  }
}

/** The chain refused a transaction: it will never land as it is. */
export class TransactionRejectedError extends ServiceRouterError {
  readonly code = 'transaction_rejected';
}

export interface AddressTransaction {
  readonly txHash: string;
  readonly blockHeight: number;
  readonly blockTime: Date;
}

export interface TransactionOutput {
  readonly address: string;
  readonly outputIndex: number;
  // Blockfrost's units: `lovelace`, or a native asset's policy ID and asset name hex, joined
  readonly amounts: readonly { readonly unit: string; readonly quantity: bigint }[];
}

/** What the deposit watcher reads through Blockfrost (DP-2). */
export interface BlockfrostClient {
  /** The latest block's height. */
  latestBlockHeight(): Promise<number>;
  /** The address's transactions from this block height on, oldest first. Empty for an address never used. */
  addressTransactions(address: string, fromHeight: number): Promise<readonly AddressTransaction[]>;
  /** The transaction's outputs, or undefined when the chain doesn't know it (any more). */
  transactionOutputs(txHash: string): Promise<readonly TransactionOutput[] | undefined>;
  /** The transaction's block height, or undefined when the chain doesn't know it (any more). */
  transactionHeight(txHash: string): Promise<number | undefined>;
  /** What the address holds, by unit. Empty for an address never used. */
  addressAmounts(address: string): Promise<ReadonlyMap<string, bigint>>;
  /** Submits a signed transaction (CBOR in hex). Returns its hash. Throws TransactionRejectedError when the chain refuses it. */
  submitTransaction(cborHex: string): Promise<string>;
}

export interface BlockfrostClientOptions {
  // Such as https://cardano-mainnet.blockfrost.io/api/v0
  readonly url: string;
  // BLOCKFROST_PROJECT_ID
  readonly projectId: Secret;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}

// Blockfrost pages hold at most 100 items
const pageSize = 100;
// A deposit address with more transactions than this between two checks is read on the next check
const maxPages = 5;

const toNumber = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new BlockfrostError(`Blockfrost answered ${what} without a number`);

  return value;
};

/** A small Blockfrost client for the deposit watcher. Blockfrost is our provider, not a URL a seller or buyer gives. */
export const createBlockfrostClient = ({ url, projectId, timeoutMs, fetch = globalThis.fetch }: BlockfrostClientOptions): BlockfrostClient => {
  const base = url.replace(/\/+$/, '');

  const get = async (path: string, what: string): Promise<unknown> => {
    const started = performance.now();
    const call = (status?: number): BlockfrostCall => ({ method: 'GET', path, ...status === undefined ? {} : { status }, durationMs: performance.now() - started });
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, { headers: { project_id: projectId.expose() }, signal: AbortSignal.timeout(timeoutMs) });
    }
    catch (error) {
      throw new BlockfrostError(`Blockfrost didn't answer ${what}`, { cause: error, ...call() });
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new BlockfrostError(`Blockfrost answered ${what} with status ${response.status}`, call(response.status));
    }
    try {
      return await response.json();
    }
    catch (error) {
      throw new BlockfrostError(`Blockfrost answered ${what} with invalid JSON`, { cause: error, ...call(response.status) });
    }
  };

  return {
    latestBlockHeight: async () => {
      const block = await get('/blocks/latest', 'the latest block');
      if (!isRecord(block))
        throw new BlockfrostError('Blockfrost answered the latest block without one');

      return toNumber(block['height'], 'the latest block');
    },

    addressTransactions: async (address, fromHeight) => {
      const found: AddressTransaction[] = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const query = new URLSearchParams({ order: 'asc', count: String(pageSize), page: String(page), from: String(fromHeight) });
        const items = await get(`/addresses/${encodeURIComponent(address)}/transactions?${query}`, 'an address\'s transactions');
        if (items === undefined)
          return found;
        if (!Array.isArray(items))
          throw new BlockfrostError('Blockfrost answered an address\'s transactions without a list');

        for (const item of items) {
          if (!isRecord(item) || typeof item['tx_hash'] !== 'string')
            throw new BlockfrostError('Blockfrost answered an address\'s transactions with an invalid item');
          found.push({
            txHash: item['tx_hash'],
            blockHeight: toNumber(item['block_height'], 'a transaction'),
            blockTime: new Date(toNumber(item['block_time'], 'a transaction') * 1_000),
          });
        }
        if (items.length < pageSize)
          break;
      }

      return found;
    },

    transactionOutputs: async txHash => {
      const utxos = await get(`/txs/${encodeURIComponent(txHash)}/utxos`, 'a transaction\'s outputs');
      if (utxos === undefined)
        return undefined;
      if (!isRecord(utxos) || !Array.isArray(utxos['outputs']))
        throw new BlockfrostError('Blockfrost answered a transaction\'s outputs without a list');

      return utxos['outputs'].map((output: unknown): TransactionOutput => {
        if (!isRecord(output) || typeof output['address'] !== 'string' || !Array.isArray(output['amount']))
          throw new BlockfrostError('Blockfrost answered a transaction with an invalid output');

        return {
          address: output['address'],
          outputIndex: toNumber(output['output_index'], 'an output'),
          amounts: output['amount'].map((amount: unknown) => {
            if (!isRecord(amount) || typeof amount['unit'] !== 'string' || typeof amount['quantity'] !== 'string' || !/^\d+$/.test(amount['quantity']))
              throw new BlockfrostError('Blockfrost answered an output with an invalid amount');

            return { unit: amount['unit'], quantity: BigInt(amount['quantity']) };
          }),
        };
      });
    },

    addressAmounts: async address => {
      const found = await get(`/addresses/${encodeURIComponent(address)}`, 'an address');
      if (found === undefined)
        return new Map();
      if (!isRecord(found) || !Array.isArray(found['amount']))
        throw new BlockfrostError('Blockfrost answered an address without its amounts');

      return new Map(found['amount'].map((amount: unknown) => {
        if (!isRecord(amount) || typeof amount['unit'] !== 'string' || typeof amount['quantity'] !== 'string' || !/^\d+$/.test(amount['quantity']))
          throw new BlockfrostError('Blockfrost answered an address with an invalid amount');

        return [amount['unit'], BigInt(amount['quantity'])] as const;
      }));
    },

    submitTransaction: async cborHex => {
      const started = performance.now();
      const call = (status?: number): BlockfrostCall => ({ method: 'POST', path: '/tx/submit', ...status === undefined ? {} : { status }, durationMs: performance.now() - started });
      let response: Response;
      try {
        response = await fetch(`${base}/tx/submit`, {
          method: 'POST',
          headers: { project_id: projectId.expose(), 'content-type': 'application/cbor' },
          body: Buffer.from(cborHex, 'hex'),
          signal: AbortSignal.timeout(timeoutMs),
        });
      }
      catch (error) {
        throw new BlockfrostError('Blockfrost didn\'t answer a transaction submission', { cause: error, ...call() });
      }
      // 400: the node refused it, such as spent inputs or a passed validity window
      if (response.status === 400) {
        await response.body?.cancel();
        throw new TransactionRejectedError('The chain refused the transaction');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new BlockfrostError(`Blockfrost answered a transaction submission with status ${response.status}`, call(response.status));
      }
      const hash = await response.json() as unknown;
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))
        throw new BlockfrostError('Blockfrost answered a transaction submission without a hash');

      return hash;
    },

    transactionHeight: async txHash => {
      const transaction = await get(`/txs/${encodeURIComponent(txHash)}`, 'a transaction');
      if (transaction === undefined)
        return undefined;
      if (!isRecord(transaction))
        throw new BlockfrostError('Blockfrost answered a transaction without one');

      return toNumber(transaction['block_height'], 'a transaction');
    },
  };
};
