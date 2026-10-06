import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger, createShutdownHandler } from '../src/index.js';

const logger = createLogger({ level: 'silent' });

describe('createShutdownHandler (CK-6)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the shutdown hooks once and exits with 0', async () => {
    const dispose = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = createShutdownHandler({ dispose, logger, exit });

    await shutdown('SIGTERM');
    await shutdown('SIGINT');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits with 1 when a hook fails', async () => {
    const exit = vi.fn();
    await createShutdownHandler({ dispose: async () => {
      throw new Error('close failed');
    }, logger, exit })('SIGTERM');

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('forces the exit after the timeout', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    void createShutdownHandler({ dispose: () => new Promise(() => undefined), logger, exit, timeoutMs: 30_000 })('SIGTERM');

    await vi.advanceTimersByTimeAsync(29_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
