import { afterEach, describe, expect, it, vi } from 'vitest';

import { runApp, ServiceRouterError } from '../../src/index.js';
import { captureLogs } from './helpers.js';

class ConfigError extends ServiceRouterError {
  readonly code = 'config_invalid';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runApp', () => {
  it('logs why the app can\'t start and exits with 1', async () => {
    const { logger, lines } = captureLogs();
    const exit = vi.fn();
    const processOn = vi.spyOn(process, 'on');

    await runApp({
      name: 'api',
      logger,
      exit,
      env: {},
      start: async () => {
        throw new ConfigError('Invalid platform config: /keyPrefixes/master must not start with /keyPrefixes/payment');
      },
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toEqual([expect.objectContaining({
      level: 60,
      msg: 'Failed to start',
      error: expect.objectContaining({ message: 'Invalid platform config: /keyPrefixes/master must not start with /keyPrefixes/payment' }),
    })]);
    expect(processOn).not.toHaveBeenCalled();
  });

  it('passes the environment and logger to start, and on SIGTERM closes the app and exits with 0 (CK-6)', async () => {
    const { logger } = captureLogs();
    const exit = vi.fn();
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => void) => {
      handlers.set(event, handler);

      return process;
    }) as typeof process.on);
    const close = vi.fn(async () => undefined);
    const start = vi.fn(async () => ({ close }));
    const env = { PORT: '8181' };

    await runApp({ name: 'api', logger, exit, env, start });

    expect(start).toHaveBeenCalledWith({ env, logger });
    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']);
    handlers.get('SIGTERM')!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
