import { BaseError, createClient, http, HttpRequestError, SocketClosedError, TimeoutError, type Chain, type Client } from 'viem';
import { getChainId } from 'viem/actions';
import { tempo, tempoModerato } from 'viem/chains';

import { withTimeout } from '@servicerouter/common';
import type { NetworkInfo } from '@servicerouter/core';

// The Tempo chains platform config allows (core's supportedNetworks), from viem's definitions
const chains: Readonly<Record<string, Chain>> = {
  [`eip155:${tempo.id}`]: tempo,
  [`eip155:${tempoModerato.id}`]: tempoModerato,
};

/** The Tempo RPC of `mpp.network` (PC-6). It holds no credential. */
export interface TempoRpc {
  readonly chain: Chain;
  /** A client whose every call gives up after `timeoutMs`, without retries. */
  client(timeoutMs: number): Client;
  /** Throws unless the RPC answers with the chain ID of `mpp.network` within the timeout. */
  check(timeoutMs: number): Promise<void>;
}

export interface TempoRpcOptions {
  // mpp.network
  readonly network: NetworkInfo;
  // mpp.rpcUrl. Default: the chain's public RPC, from viem's chain definition.
  readonly url?: string | undefined;
}

/** The RPC answered with another chain than `mpp.network`. */
export class TempoChainMismatchError extends Error {
  constructor(readonly expected: number, readonly answered: number) {
    super(`The Tempo RPC answers chain ID ${answered}, not ${expected} (mpp.network)`);
  }
}

export const createTempoRpc = ({ network, url }: TempoRpcOptions): TempoRpc => {
  const chain = chains[network.id];
  if (!chain)
    throw new Error(`${network.id} isn't a Tempo network viem knows`);
  const rpcUrl = url ?? chain.rpcUrls.default.http[0];
  if (!rpcUrl)
    throw new Error(`viem has no public RPC for ${network.id}. Set mpp.rpcUrl`);

  // One client per timeout, so readiness probes don't build a new one each time
  const clients = new Map<number, Client>();
  const client = (timeoutMs: number): Client => {
    let found = clients.get(timeoutMs);
    if (!found) {
      found = createClient({ chain, transport: http(rpcUrl, { timeout: timeoutMs, retryCount: 0 }) });
      clients.set(timeoutMs, found);
    }

    return found;
  };

  return {
    chain,
    client,
    check: async timeoutMs => {
      const answered = await withTimeout(() => getChainId(client(timeoutMs)), { timeoutMs });
      if (answered !== chain.id)
        throw new TempoChainMismatchError(chain.id, answered);
    },
  };
};

// JSON-RPC errors that say the node or its provider is struggling, not that the payment is wrong:
// internal error, resource unavailable, and limit exceeded
const unavailableCodes = new Set([-32_603, -32_002, -32_005]);
// EIP-7966 (eth_sendRawTransactionSync): the transaction is in the mempool, not final yet
const pendingCodes = new Set([4, 5]);

/**
 * What an RPC failure says, from viem's error and its causes:
 * - `unavailable`: no answer, a timeout, an HTTP error, or a node too busy to answer;
 * - `pending`: the node took the transaction but it isn't final (EIP-7966);
 * - `refused`: the node answered with a JSON-RPC error, such as an execution revert or a rejected
 *   transaction;
 * - undefined: not an RPC failure.
 */
export const rpcFailure = (error: unknown): 'unavailable' | 'pending' | 'refused' | undefined => {
  if (!(error instanceof BaseError))
    return undefined;
  if (error.walk(cause => cause instanceof HttpRequestError || cause instanceof TimeoutError || cause instanceof SocketClosedError))
    return 'unavailable';

  const coded = error.walk(cause => typeof (cause as { code?: unknown }).code === 'number') as { code?: number } | null;
  if (typeof coded?.code !== 'number')
    return undefined;
  if (pendingCodes.has(coded.code))
    return 'pending';

  return unavailableCodes.has(coded.code) ? 'unavailable' : 'refused';
};

/**
 * An error's one-line reason, for logs. viem's full message carries the request body, and a broadcast's
 * body is the buyer's signed transaction, so it never reaches a log (rule 10).
 */
export const errorReason = (error: unknown): string => error instanceof BaseError
  ? error.shortMessage
  : error instanceof Error ? error.message.split('\n', 1)[0]! : 'unknown error';
