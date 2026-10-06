import { describe, expect, it, vi } from 'vitest';

import { createLogger, runApp } from '@servicerouter/common';
import { loadPlatformConfig } from '@servicerouter/core';

import { createApp } from '../src/app.js';
import { startWeb } from '../src/start.js';

describe('web shell (XC-3)', () => {
  it('answers health and readiness, with no checks yet', async () => {
    const config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
    const server = createApp({ config, logger: createLogger({ level: 'silent' }) });
    try {
      expect((await server.app.inject({ method: 'GET', url: '/_/health' })).statusCode).toBe(200);
      expect((await server.app.inject({ method: 'GET', url: '/_/ready' })).json()).toEqual({ status: 'ready', checks: {} });
    }
    finally {
      await server.close();
    }
  });

  it('exits with 1 when the platform config is missing (PC-1)', async () => {
    const exit = vi.fn();

    await runApp({ name: 'web', start: startWeb, logger: createLogger({ level: 'silent' }), exit, env: {} });

    expect(exit).toHaveBeenCalledWith(1);
  });
});
