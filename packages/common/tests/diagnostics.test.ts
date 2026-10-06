import { describe, expect, it } from 'vitest';

import {
  BlockedAddressError, ConnectionFailedError, createLogger, OutboundTimeoutError, outboundErrorCode, outboundFields, serializeError, ServiceRouterError,
  upstreamRequestIdOf,
} from '../src/index.js';

class InsufficientBalanceError extends ServiceRouterError {
  readonly code = 'insufficient_balance';
}

// viem's errors keep the request in their message: for a broadcast, the signed transaction
class FakeViemError extends Error {
  override readonly name = 'HttpRequestError';
  readonly shortMessage = 'HTTP request failed.';
  readonly version = 'viem@2.57.3';
  readonly status = 503;
  readonly url = 'https://rpc.example/v2/rpc-api-key-in-path?key=rpc-query-key';
  readonly body = { method: 'eth_sendRawTransactionSync', params: ['0x76f8signedtransaction'] };

  constructor() {
    super('HTTP request failed.\n\nStatus: 503\nURL: https://rpc.example/v2/rpc-api-key-in-path?key=rpc-query-key\nRequest body: {"params":["0x76f8signedtransaction"]}');
  }
}

const capture = () => {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

  return { logger, lines };
};

describe('the error serializer (L-9)', () => {
  it('gives an unexpected error its type, message, code, cause chain, and a stack', () => {
    const connect = Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:5432'), { code: 'ECONNREFUSED', syscall: 'connect' });
    const failure = new TypeError('fetch failed', { cause: connect });

    const serialized = serializeError(failure);

    expect(serialized).toMatchObject({
      type: 'TypeError',
      message: 'fetch failed: connect ECONNREFUSED 10.0.0.7:5432',
      cause: { type: 'Error', message: 'connect ECONNREFUSED 10.0.0.7:5432', code: 'ECONNREFUSED', syscall: 'connect' },
    });
    expect(serialized.stack).toMatch(/^TypeError: fetch failed\n\s+at /);
    expect(serialized.cause!.stack).toBeUndefined();
  });

  it('gives a coded error of ours its code and safe fields, without a stack: it is expected', () => {
    const blocked = new BlockedAddressError('internal.example', '10.0.0.1', 'a private address');

    expect(serializeError(new InsufficientBalanceError('Credits don\'t cover the price'))).toEqual({
      type: 'InsufficientBalanceError', message: 'Credits don\'t cover the price', code: 'insufficient_balance',
    });
    expect(serializeError(blocked)).toEqual({ type: 'BlockedAddressError', message: 'internal.example resolves to a private address', code: 'blocked_address', host: 'internal.example' });
  });

  it('reduces a viem error to its short message and status: never its URL or the signed transaction in its request', () => {
    const { logger, lines } = capture();

    logger.warn({ error: new Error('The broadcast failed', { cause: new FakeViemError() }) }, 'failed');

    const logged = JSON.stringify(lines);
    expect(lines[0]).toMatchObject({
      error: { message: 'The broadcast failed: HTTP request failed.', cause: { type: 'HttpRequestError', message: 'HTTP request failed.', status: 503 } },
    });
    for (const secret of ['0x76f8signedtransaction', 'rpc-api-key-in-path', 'rpc-query-key', 'Request body'])
      expect(logged).not.toContain(secret);
  });

  it('reduces the x402 SDK\'s and mppx\'s errors to their reason and status', () => {
    const verify = Object.assign(new Error('invalid_exact_evm_signature: the buyer 0xabc signed for someone else'), {
      name: 'VerifyError', statusCode: 400, invalidReason: 'invalid_exact_evm_signature', invalidMessage: 'the buyer 0xabc signed for someone else', payer: '0xabc',
    });
    const mppx = Object.assign(new Error('Payment verification failed: amount mismatch.\nCredential: eyJzZWNyZXQiOiJ0eCJ9'), {
      name: 'VerificationFailedError', status: 402, details: { credential: 'eyJzZWNyZXQiOiJ0eCJ9' }, toProblemDetails: () => ({}),
    });

    expect(serializeError(verify)).toMatchObject({ type: 'VerifyError', message: 'invalid_exact_evm_signature', status: 400, reason: 'invalid_exact_evm_signature' });
    expect(JSON.stringify(serializeError(verify))).not.toContain('someone else');
    expect(serializeError(mppx)).toMatchObject({ type: 'VerificationFailedError', message: 'Payment verification failed: amount mismatch.', status: 402 });
    expect(JSON.stringify(serializeError(mppx))).not.toContain('eyJzZWNyZXQiOiJ0eCJ9');
  });

  it('strips a URL\'s query from a message, and the text a JSON parse quotes', () => {
    const fetchError = new Error('Failed to fetch https://api.example.com/v1/data?api_key=query-secret#fragment');
    let parseError: unknown;
    try {
      JSON.parse('{"masterKey":"srm_test_secret"');
    }
    catch (error) {
      parseError = error;
    }

    expect(serializeError(fetchError).message).toBe('Failed to fetch https://api.example.com/v1/data');
    expect(JSON.stringify(serializeError(parseError))).not.toContain('srm_test_secret');
  });

  it('serializes what isn\'t an Error without dumping it, and stops at a cycle', () => {
    const looped = new Error('first');
    const second = new Error('second', { cause: looped });
    Object.assign(looped, { cause: second });

    expect(serializeError({ password: 'object-secret' })).toEqual({ type: 'object', message: 'A thrown value that isn\'t an Error' });
    expect(serializeError('plain reason')).toEqual({ type: 'string', message: 'plain reason' });
    expect(serializeError(looped)).toMatchObject({ message: 'first: second', cause: { message: 'second' } });
  });

  it('is the logger\'s serializer for error and err, as rejections log it', () => {
    const { logger, lines } = capture();

    logger.fatal({ error: new Error('unhandled') }, 'Unhandled rejection');
    logger.error({ err: new InsufficientBalanceError('no credits') }, 'failed');

    expect(lines[0]).toMatchObject({ error: { type: 'Error', message: 'unhandled', stack: expect.stringContaining('diagnostics.test.ts') } });
    expect(lines[1]).toMatchObject({ err: { code: 'insufficient_balance', message: 'no credits' } });
  });
});

describe('outbound call fields (L-4)', () => {
  it('name the host, method, path without its query, status, duration, and attempt', () => {
    expect(outboundFields({ url: 'https://api.example.com:8443/v1/pools?api_key=query-secret', method: 'post', status: 503, durationMs: 12.6, attempt: 2 })).toEqual({
      host: 'api.example.com:8443', method: 'POST', path: '/v1/pools', status: 503, durationMs: 13, attempt: 2,
    });
  });

  it.each([
    ['ECONNREFUSED from deep in the causes', new ConnectionFailedError('a.example', { cause: new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }) }), 'ECONNREFUSED'],
    ['a TLS verification error', new ConnectionFailedError('a.example', { cause: Object.assign(new Error('expired'), { code: 'CERT_HAS_EXPIRED' }) }), 'CERT_HAS_EXPIRED'],
    ['the address policy', new BlockedAddressError('a.example', '10.0.0.1', 'a private address'), 'blocked_address'],
    ['Outbound HTTP\'s timeout', new OutboundTimeoutError('a.example', 'total', 30_000), 'outbound_timeout'],
    ['an AbortSignal timeout', new Error('fetch failed', { cause: new DOMException('The operation timed out', 'TimeoutError') }), 'timeout'],
    ['an ETIMEDOUT in an AggregateError', new AggregateError([Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })], 'all failed'), 'ETIMEDOUT'],
  ])('say why a call failed: %s', (_case, error, code) => {
    expect(outboundErrorCode(error)).toBe(code);
    expect(outboundFields({ url: 'https://a.example/x', error })).toMatchObject({ code });
  });

  it('read an upstream\'s own request ID, when it sends a usable one (L-2)', () => {
    expect(upstreamRequestIdOf({ 'x-request-id': 'up-123' })).toBe('up-123');
    expect(upstreamRequestIdOf({ 'cf-ray': '8a1b2c3d4e5f-AMS' })).toBe('8a1b2c3d4e5f-AMS');
    expect(upstreamRequestIdOf({ 'x-request-id': 'has spaces and\nnewlines' })).toBeUndefined();
    expect(upstreamRequestIdOf({})).toBeUndefined();
  });
});
