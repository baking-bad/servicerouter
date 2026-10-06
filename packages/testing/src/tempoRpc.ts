import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';

import { Challenge, Credential } from 'mppx';
import { Mppx, tempo } from 'mppx/client';
import {
  createClient, decodeFunctionData, encodeAbiParameters, encodeEventTopics, http, keccak256, numberToHex, type Address, type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { Abis, Transaction } from 'viem/tempo';

import type { TestCertificate } from './certificate.js';

// Tempo Moderato, the testnet in config/example.yaml
export const moderatoChainId = 42_431;
// pathUSD on every Tempo network: a TIP-20 stablecoin with 6 decimals
export const pathUsdAddress = '0x20c0000000000000000000000000000000000000';

/**
 * What the fake does with the next raw transaction:
 * - `confirm`: includes it, and answers with a successful receipt carrying its TIP-20 transfer logs;
 * - `revert`: includes it with a reverted receipt and no logs;
 * - `refuse`: the node refuses it with a JSON-RPC error, and nothing is included;
 * - `fail`: answers HTTP 503, and nothing is included;
 * - `timeout`: takes the transaction, holds the answer past the client's timeout, and leaves it
 *   pending until `include` makes its receipt known.
 */
export type TempoBroadcast = 'confirm' | 'revert' | 'refuse' | 'fail' | 'timeout';

/** What the fake answers to a simulation (`eth_call`): success, or an execution revert. */
export type TempoSimulation = 'ok' | 'revert';

export interface TempoRpcCall {
  readonly method: string;
  readonly params: readonly unknown[];
}

export interface FakeTempoRpc {
  readonly url: string;
  // Every JSON-RPC call, in order
  readonly calls: readonly TempoRpcCall[];
  // Methods it doesn't fake, in order. Each got a JSON-RPC "method not found".
  readonly unknownMethods: readonly string[];
  // Every raw transaction sent to it, as sent
  readonly rawTransactions: readonly Hex[];
  /** How the next raw transactions are treated, until `reset`. */
  broadcast(outcome: TempoBroadcast): void;
  /** How simulations are answered, until `reset`. */
  simulate(outcome: TempoSimulation): void;
  /** The chain ID it answers, such as another network's, until `reset`. */
  answerChainId(chainId: number): void;
  /** While true, every call answers HTTP 503, such as for readiness. */
  unavailable(down: boolean): void;
  /** Makes a pending transaction's receipt known, as included with that status. */
  include(hash: Hex, status?: 'success' | 'reverted'): void;
  /** The transaction hashes it holds: included or pending. */
  readonly transactions: readonly Hex[];
  /** Back to the defaults, and clears the logs. The transactions it holds stay. */
  reset(): void;
  close(): Promise<void>;
}

export interface FakeTempoRpcOptions {
  readonly chainId?: number;
  // How long a `timeout` broadcast holds its answer. Default: 2 s, past the tests' RPC timeouts.
  readonly timeoutMs?: number;
  // Serve HTTPS with this certificate, as `mpp.rpcUrl` must be. See `trustTestCertificate`.
  readonly tls?: TestCertificate;
}

interface Held {
  readonly hash: Hex;
  readonly from: Address;
  readonly logs: readonly Record<string, unknown>[];
  receipt: Record<string, unknown> | undefined;
}

const zeroHash = `0x${'0'.repeat(64)}` as Hex;
const blockHash = `0x${'b'.repeat(64)}` as Hex;
const blockNumber = 1_000n;

// A TIP-20 call's transfer events: Transfer, and TransferWithMemo after it when the call has a memo
const transferLogs = (from: Address, call: { readonly to?: Address | null; readonly data?: Hex }): Record<string, unknown>[] => {
  if (!call.to || !call.data)
    return [];
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: Abis.tip20, data: call.data });
  }
  catch {
    return [];
  }
  const log = (eventName: 'Transfer' | 'TransferWithMemo', args: Record<string, unknown>) => ({
    address: call.to,
    topics: encodeEventTopics({ abi: Abis.tip20, eventName, args } as Parameters<typeof encodeEventTopics>[0]),
    data: encodeAbiParameters([{ type: 'uint256' }], [args['amount'] as bigint]),
  });
  if (decoded.functionName === 'transfer') {
    const [to, amount] = decoded.args as readonly [Address, bigint];
    return [log('Transfer', { from, to, amount })];
  }
  if (decoded.functionName === 'transferWithMemo') {
    const [to, amount, memo] = decoded.args as readonly [Address, bigint, Hex];
    return [log('Transfer', { from, to, amount }), log('TransferWithMemo', { from, to, amount, memo })];
  }

  return [];
};

/**
 * A Tempo node's JSON-RPC on 127.0.0.1, offline: just what `mppx`'s Tempo charge client and server
 * call to sign, validate, broadcast, and confirm a payment, and what the settlement follow-up reads.
 * - The client: `eth_fillTransaction` (answered "not found", so viem fills the fields itself),
 *   `eth_getBlockByNumber`, `eth_maxPriorityFeePerGas`, `eth_estimateGas`, and `eth_chainId`.
 * - The server: `eth_call` to simulate, and `eth_sendRawTransactionSync` to broadcast.
 * - The follow-up: `eth_getTransactionReceipt`. The startup check: `eth_chainId`.
 *
 * Methods it doesn't know are logged in `unknownMethods`. Raw transactions are decoded, so a receipt
 * carries the TIP-20 transfer logs the signed transaction makes.
 */
export const startFakeTempoRpc = async ({ chainId = moderatoChainId, timeoutMs = 2_000, tls }: FakeTempoRpcOptions = {}): Promise<FakeTempoRpc> => {
  const calls: TempoRpcCall[] = [];
  const unknownMethods: string[] = [];
  const rawTransactions: Hex[] = [];
  const held = new Map<string, Held>();
  let nextBroadcast: TempoBroadcast = 'confirm';
  let simulation: TempoSimulation = 'ok';
  let answeredChainId = chainId;
  let down = false;

  const receiptOf = (transaction: Held, status: 'success' | 'reverted'): Record<string, unknown> => ({
    transactionHash: transaction.hash,
    transactionIndex: '0x0',
    blockHash,
    blockNumber: numberToHex(blockNumber),
    from: transaction.from,
    to: null,
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    effectiveGasPrice: '0x1',
    contractAddress: null,
    logs: (status === 'success' ? transaction.logs : []).map((log, index) => ({
      ...log,
      blockHash,
      blockNumber: numberToHex(blockNumber),
      transactionHash: transaction.hash,
      transactionIndex: '0x0',
      logIndex: numberToHex(index),
      removed: false,
    })),
    logsBloom: `0x${'0'.repeat(512)}`,
    status: status === 'success' ? '0x1' : '0x0',
    type: '0x76',
  });

  const take = async (raw: Hex): Promise<Held> => {
    rawTransactions.push(raw);
    const transaction = Transaction.deserialize(raw) as { from?: Address; calls?: readonly { to?: Address | null; data?: Hex }[] };
    // The hash of the canonical envelope, as a node derives it
    const hash = keccak256(await Transaction.serialize(Transaction.deserialize(raw) as Parameters<typeof Transaction.serialize>[0]));
    const from = transaction.from ?? '0x0000000000000000000000000000000000000000';
    const entry: Held = { hash, from, logs: (transaction.calls ?? []).flatMap(call => transferLogs(from, call)), receipt: undefined };
    held.set(hash.toLowerCase(), entry);

    return entry;
  };

  type Answer = { readonly result: unknown } | { readonly error: { readonly code: number; readonly message: string } } | { readonly status: number };

  const answer = async (method: string, params: readonly unknown[]): Promise<Answer> => {
    switch (method) {
      case 'eth_chainId':
        return { result: numberToHex(answeredChainId) };
      case 'eth_getBlockByNumber':
        return {
          result: {
            number: numberToHex(blockNumber), hash: blockHash, parentHash: zeroHash, timestamp: numberToHex(Math.floor(Date.now() / 1_000)),
            baseFeePerGas: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', miner: '0x0000000000000000000000000000000000000000',
            transactions: [], difficulty: '0x0', extraData: '0x', logsBloom: `0x${'0'.repeat(512)}`, nonce: '0x0000000000000000',
            sha3Uncles: zeroHash, size: '0x0', stateRoot: zeroHash, receiptsRoot: zeroHash, transactionsRoot: zeroHash, uncles: [],
            mixHash: zeroHash, totalDifficulty: '0x0',
          },
        };
      case 'eth_estimateGas':
        return { result: numberToHex(100_000) };
      case 'eth_maxPriorityFeePerGas':
        return { result: '0x1' };
      case 'eth_call':
        return simulation === 'ok'
          ? { result: '0x' }
          : { error: { code: 3, message: 'execution reverted: insufficient balance' } };
      case 'eth_sendRawTransactionSync': {
        const outcome = nextBroadcast;
        if (outcome === 'fail') {
          rawTransactions.push(params[0] as Hex);
          return { status: 503 };
        }
        if (outcome === 'refuse') {
          rawTransactions.push(params[0] as Hex);
          return { error: { code: -32003, message: 'transaction rejected' } };
        }
        const transaction = await take(params[0] as Hex);
        if (outcome === 'timeout') {
          await new Promise(resolve => setTimeout(resolve, timeoutMs));
          return { error: { code: 4, message: 'the transaction wasn\'t processed in time' } };
        }
        transaction.receipt = receiptOf(transaction, outcome === 'confirm' ? 'success' : 'reverted');

        return { result: transaction.receipt };
      }
      case 'eth_getTransactionReceipt':
        return { result: held.get(String(params[0]).toLowerCase())?.receipt ?? null };
      // viem tries the node's filling first, and fills the fields itself when it isn't there
      case 'eth_fillTransaction':
        return { error: { code: -32601, message: 'eth_fillTransaction isn\'t faked' } };
      default:
        unknownMethods.push(method);
        return { error: { code: -32601, message: `${method} isn't faked` } };
    }
  };

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; method: string; params?: unknown[] };
        calls.push({ method: body.method, params: body.params ?? [] });
        if (down) {
          response.writeHead(503).end();
          return;
        }
        const result = await answer(body.method, body.params ?? []);
        if ('status' in result) {
          response.writeHead(result.status).end();
          return;
        }
        if (response.destroyed)
          return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...result }));
      })();
    });
  };
  const server = tls ? createTlsServer({ cert: tls.cert, key: tls.key }, handle) : createServer(handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    calls,
    unknownMethods,
    rawTransactions,
    broadcast: outcome => {
      nextBroadcast = outcome;
    },
    simulate: outcome => {
      simulation = outcome;
    },
    answerChainId: id => {
      answeredChainId = id;
    },
    unavailable: value => {
      down = value;
    },
    include: (hash, status = 'success') => {
      const transaction = held.get(hash.toLowerCase());
      if (!transaction)
        throw new Error(`The fake Tempo RPC never received ${hash}`);
      transaction.receipt = receiptOf(transaction, status);
    },
    get transactions() {
      return [...held.values()].map(transaction => transaction.hash);
    },
    reset: () => {
      // The transactions it holds stay, so a test can include one that timed out
      calls.length = 0;
      unknownMethods.length = 0;
      rawTransactions.length = 0;
      nextBroadcast = 'confirm';
      simulation = 'ok';
      answeredChainId = chainId;
      down = false;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
};

export interface TestTempoPayer {
  // The payer's address, from a key made in the test
  readonly address: Address;
  /** The MPP credential for a 402's Tempo charge, signed in pull mode by `mppx`'s client. */
  credentialFor(response: Response): Promise<string>;
}

export interface TestTempoPayerOptions {
  // The fake Tempo RPC, which the client asks for fees and gas
  readonly rpcUrl: string;
}

/** A buyer with a Tempo wallet: `mppx`'s client with a viem account generated in the test, on Moderato. */
export const createTestTempoPayer = ({ rpcUrl }: TestTempoPayerOptions): TestTempoPayer => {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = createClient({ chain: tempoModerato, transport: http(rpcUrl, { retryCount: 0 }) });
  const mppx = Mppx.create({ methods: [tempo.charge({ account, getClient: () => client })], polyfill: false });

  return {
    address: account.address,
    credentialFor: response => mppx.createCredential(response),
  };
};

/** The same credential with one byte of its transaction's signature changed: it no longer recovers the payer. */
export const tamperMppSignature = (header: string): string => {
  const credential = Credential.deserialize(header);
  const payload = credential.payload as { readonly signature: Hex; readonly type: string };
  const position = payload.signature.length - 20;
  const flipped = (Number.parseInt(payload.signature.slice(position, position + 2), 16) ^ 0x01).toString(16).padStart(2, '0');

  const signature = `${payload.signature.slice(0, position)}${flipped}${payload.signature.slice(position + 2)}`;

  return Credential.serialize({ ...credential, payload: { ...payload, signature } });
};

/** A push (hash) credential for a 402's Tempo charge: a transaction the payer says it broadcast itself. */
export const pushMppCredential = (response: Response, payer: Address, hash: Hex = `0x${'1'.repeat(64)}`): string => {
  const challenge = Challenge.fromResponse(response);
  const chainId = (challenge.request['methodDetails'] as { readonly chainId?: number } | undefined)?.chainId ?? moderatoChainId;

  return Credential.serialize({ challenge, payload: { hash, type: 'hash' }, source: `did:pkh:eip155:${chainId}:${payer}` });
};
