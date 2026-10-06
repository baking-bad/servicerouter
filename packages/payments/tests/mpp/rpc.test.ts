import { HttpRequestError, InternalRpcError, RpcRequestError, TimeoutError, TransactionRejectedRpcError } from 'viem';
import { describe, expect, it } from 'vitest';

import { errorReason, rpcFailure } from '../../src/index.js';

// A broadcast's request body: the buyer's signed transaction
const body = { method: 'eth_sendRawTransactionSync', params: ['0x76f8fc82a5bf0102signed'] };
const url = 'https://rpc.moderato.tempo.xyz';
const answered = (code: number) => new RpcRequestError({ body, error: { code, message: 'the node says no' }, url });

describe('Tempo RPC failures (PR-9, PR-12)', () => {
  it.each([
    ['no answer in time', new TimeoutError({ body, url }), 'unavailable'],
    ['an HTTP error', new HttpRequestError({ body, url, status: 503 }), 'unavailable'],
    ['a node too busy to answer', new InternalRpcError(answered(-32_603)), 'unavailable'],
    ['a transaction in the mempool, not final (EIP-7966)', answered(4), 'pending'],
    ['a rejected transaction', new TransactionRejectedRpcError(answered(-32_003)), 'refused'],
    ['an execution revert', answered(3), 'refused'],
    ['an error that isn\'t the RPC\'s', new Error('Transaction reverted: 0xabc'), undefined],
  ])('tells %s apart', (_case, error, failure) => {
    expect(rpcFailure(error)).toBe(failure);
  });

  it('gives a one-line reason for logs, never the request body with the signed transaction (rule 10)', () => {
    const errors = [new TimeoutError({ body, url }), new HttpRequestError({ body, url, status: 503 }), new TransactionRejectedRpcError(answered(-32_003))];

    for (const error of errors) {
      expect(error.message).toContain('0x76f8fc82a5bf0102signed');
      expect(errorReason(error)).not.toContain('0x76f8fc82a5bf0102signed');
      expect(errorReason(error)).not.toContain('\n');
    }
    expect(errorReason(new Error('first line\nsecond line'))).toBe('first line');
  });
});
