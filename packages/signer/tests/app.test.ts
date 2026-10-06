import { describe, expect, it } from 'vitest';

import { createLogger } from '@servicerouter/common';

import { createApp } from '../src/app.js';

describe('signer shell (XC-3)', () => {
  it('answers health and readiness, with no checks yet', async () => {
    const server = createApp({ logger: createLogger({ level: 'silent' }) });
    try {
      expect((await server.app.inject({ method: 'GET', url: '/_/health' })).statusCode).toBe(200);
      expect((await server.app.inject({ method: 'GET', url: '/_/ready' })).json()).toEqual({ status: 'ready', checks: {} });
    }
    finally {
      await server.close();
    }
  });
});
