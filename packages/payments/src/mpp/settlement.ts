import { Receipt } from 'mppx';
import { isAddressEqual, parseEventLogs, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import { getTransactionReceipt } from 'viem/actions';
import { Abis } from 'viem/tempo';

import { isRecord, type Clock } from '@servicerouter/common';
import type { JsonObject } from '@servicerouter/core';

import type { TempoRpc } from './rpc.js';

// The header that carries the MPP receipt to the buyer (PR-9)
export const paymentReceiptHeader = 'payment-receipt';
// A transaction included just before its validity window closed may reach the RPC's index a little
// later, so "never included" waits this long past the window
export const mppReceiptGraceMs = 60_000;

/**
 * What the settlement follow-up checks for an MPP payment whose broadcast outcome is unknown (WK-6),
 * kept on the payment as its `settlement_request`. The transaction hash comes from the signed
 * transaction, so it is known before the broadcast. Nothing here can move money.
 */
export interface MppSettlementRequest {
  readonly rail: 'mpp';
  readonly transactionHash: Hex;
  // Unix seconds: after this the transaction can never be included
  readonly validBefore: number;
  // The expected TIP-20 transfer
  readonly currency: Address;
  readonly sender: Address;
  readonly recipient: Address;
  readonly amount: string;
}

export const toMppSettlementRequest = (request: MppSettlementRequest): JsonObject => ({ ...request });

const isHex = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);

export const fromMppSettlementRequest = (value: JsonObject | undefined): MppSettlementRequest | undefined =>
  isRecord(value) && value['rail'] === 'mpp' && isHex(value['transactionHash']) && typeof value['validBefore'] === 'number'
  && isHex(value['currency']) && isHex(value['sender']) && isHex(value['recipient']) && typeof value['amount'] === 'string'
    ? value as unknown as MppSettlementRequest
    : undefined;

/** An MPP receipt (`Payment-Receipt`), as `mppx` encodes it: base64url JSON. */
export const encodeMppReceipt = (transactionHash: string, timestamp: Date): string =>
  Receipt.serialize({ method: 'tempo', reference: transactionHash, status: 'success', timestamp: timestamp.toISOString() });

export type MppSettlementStatus =
  // With the receipt the buyer would have got (PR-9)
  | { readonly status: 'settled'; readonly receipt: string }
  | { readonly status: 'failed'; readonly reason: 'reverted' | 'no_transfer' | 'expired' }
  | { readonly status: 'pending' };

/** Reads where an MPP payment stands. Throws when the RPC doesn't answer: the run tries again. */
export type MppSettlementCheck = (request: MppSettlementRequest) => Promise<MppSettlementStatus>;

export interface MppSettlementCheckOptions {
  readonly rpc: TempoRpc;
  // Each RPC call's timeout
  readonly timeoutMs: number;
  // Settlement time (WK-3)
  readonly clock: Clock;
}

/**
 * WK-6 for MPP: reads the transaction's receipt by its hash. Succeeded with the expected transfer →
 * settled. Reverted, or without that transfer → failed. Not found once its validity window has
 * passed → failed. Otherwise pending. It never broadcasts.
 */
export const createMppSettlementCheck = ({ rpc, timeoutMs, clock }: MppSettlementCheckOptions): MppSettlementCheck => {
  const client = rpc.client(timeoutMs);

  return async request => {
    let receipt;
    try {
      receipt = await getTransactionReceipt(client, { hash: request.transactionHash });
    }
    catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError))
        throw error;

      return clock.now().getTime() > request.validBefore * 1_000 + mppReceiptGraceMs ? { status: 'failed', reason: 'expired' } : { status: 'pending' };
    }
    if (receipt.status !== 'success')
      return { status: 'failed', reason: 'reverted' };

    const transfers = parseEventLogs({ abi: Abis.tip20, eventName: ['Transfer', 'TransferWithMemo'], logs: receipt.logs });
    const paid = transfers.some(log => isAddressEqual(log.address, request.currency)
      && isAddressEqual(log.args.from, request.sender)
      && isAddressEqual(log.args.to, request.recipient)
      && log.args.amount === BigInt(request.amount));

    return paid ? { status: 'settled', receipt: encodeMppReceipt(request.transactionHash, clock.now()) } : { status: 'failed', reason: 'no_transfer' };
  };
};
