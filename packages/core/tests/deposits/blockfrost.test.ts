import { describe, expect, it } from 'vitest';

import { createLogger, Secret } from '@servicerouter/common';

import { BlockfrostError, createBlockfrostClient } from '../../src/index.js';

// A failed Blockfrost call says which call, its status or the transport's code, and how long it took (L-4)

const projectId = 'mainnetProjectIdThatNeverReachesALog0123';

const client = (fetch: typeof globalThis.fetch) => createBlockfrostClient({ url: 'https://cardano-mainnet.blockfrost.io/api/v0', projectId: Secret.from(projectId), timeoutMs: 1_000, fetch });

const failure = async (work: () => Promise<unknown>): Promise<BlockfrostError> => {
  try {
    await work();
  }
  catch (error) {
    if (error instanceof BlockfrostError)
      return error;
    throw error;
  }
  throw new Error('No failure');
};

describe('Blockfrost failures (L-4, L-9)', () => {
  it('carry the method, the path without its query, the status, and the duration', async () => {
    const error = await failure(() => client(async () => new Response('{"message":"Usage is over limit"}', { status: 429 })).addressTransactions('addr1qxyz', 120));

    expect(error).toMatchObject({ code: 'blockfrost_unavailable', method: 'GET', path: '/addresses/addr1qxyz/transactions', status: 429, durationMs: expect.any(Number) });
  });

  it('log the transport\'s code from the cause, and never the project ID or a signed transaction', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const refused = async (): Promise<Response> => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:443'), { code: 'ECONNREFUSED' }) });
    };

    const read = await failure(() => client(refused).latestBlockHeight());
    const submit = await failure(() => client(refused).submitTransaction('84a400d9010281825820signedtransactioncbor'));
    logger.error({ error: read }, 'read');
    logger.error({ error: submit }, 'submit');

    expect(lines[0]).toMatchObject({ error: { code: 'blockfrost_unavailable', method: 'GET', path: '/blocks/latest', cause: { cause: { code: 'ECONNREFUSED' } } } });
    expect(lines[1]).toMatchObject({ error: { method: 'POST', path: '/tx/submit' } });
    expect(JSON.stringify(lines)).not.toMatch(new RegExp(`${projectId}|signedtransactioncbor`));
  });
});
