import { describe, expect, it } from 'vitest';

import { createLogger, Secret, type MicroUsd } from '@servicerouter/common';

import { createEndpointRegistrar, createSignerClient, SignerUnavailableError } from '../../src/routing/support.js';

// The proxy's calls to the Signer and the internal API (L-2, L-4, L-5)

const signerSecret = 'signer-secret-for-the-support-tests-0123456789';
const internalSecret = 'internal-secret-for-the-support-tests-0123456789';

const signInput = {
  requestId: 'req-support-1', quoteId: 'pay_1', x402Version: 2, requirement: {} as never, resource: undefined, url: 'https://api.target.dev/v1', quotedPrice: 1_000n as MicroUsd,
};

const refusal = async (fetch: typeof globalThis.fetch): Promise<SignerUnavailableError> => {
  try {
    await createSignerClient({ url: 'http://signer.internal:8083/', secret: Secret.from(signerSecret), timeoutMs: 1_000, fetch }).sign(signInput);
  }
  catch (error) {
    if (error instanceof SignerUnavailableError)
      return error;
    throw error;
  }
  throw new Error('No refusal');
};

describe('the Signer client (L-4, L-5)', () => {
  it('reads a 422 signing_refused\'s code and reason from the envelope, never the rest of the body', async () => {
    const error = await refusal(async () => Response.json({ error: { code: 'signing_refused', message: 'The daily spend limit is reached' }, leaked: 'body-secret' }, { status: 422 }));

    expect(error.failure).toEqual({
      host: 'signer.internal:8083', method: 'POST', path: '/internal/v1/sign', status: 422, code: 'signing_refused', reason: 'The daily spend limit is reached',
      durationMs: expect.any(Number),
    });
    expect(error.message).toBe('The Signer answered 422 signing_refused');
    expect(JSON.stringify(error.failure)).not.toContain('body-secret');
  });

  it('names the transport\'s code when the Signer doesn\'t answer, as when it is switched off', async () => {
    const error = await refusal(async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.1.4:8083'), { code: 'ECONNREFUSED' }) });
    });

    expect(error.failure).toMatchObject({ host: 'signer.internal:8083', path: '/internal/v1/sign', code: 'ECONNREFUSED' });
  });
});

describe('the routed endpoint registrar (L-2, L-4)', () => {
  it('sends the routed call\'s request ID to the internal API, and logs a failed registration with its status, never the shared secret', async () => {
    const lines: Record<string, unknown>[] = [];
    const sent: Record<string, string>[] = [];
    const registrar = createEndpointRegistrar({
      url: 'http://api.internal:8082',
      secret: Secret.from(internalSecret),
      logger: createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }),
      fetch: async (_url, init) => {
        sent.push(init?.headers as Record<string, string>);

        return new Response('{"error":{"code":"internal_error"}}', { status: 500 });
      },
    });

    registrar.register('api.target.dev', '/v1/pools', 1_100n as MicroUsd, 'req-routed-9');
    await registrar.settled();

    expect(sent[0]).toMatchObject({ 'x-request-id': 'req-routed-9', 'x-internal-caller': 'proxy' });
    expect(lines).toEqual([expect.objectContaining({
      level: 40, msg: 'The internal API refused to register a routed endpoint', requestId: 'req-routed-9', endpointHost: 'api.target.dev',
      host: 'api.internal:8082', method: 'PUT', path: '/internal/v1/routed-endpoints', status: 500, durationMs: expect.any(Number),
    })]);
    expect(JSON.stringify(lines)).not.toContain(internalSecret);
  });
});
