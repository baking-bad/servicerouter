import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimeoutError, withTimeout } from '../src/index.js';

describe('withTimeout (CK-7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result of an operation that finishes in time', async () => {
    await expect(withTimeout(async () => 'done', { timeoutMs: 1_000 })).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes through the operation\'s own error', async () => {
    await expect(withTimeout(async () => {
      throw new Error('boom');
    }, { timeoutMs: 1_000 })).rejects.toThrow('boom');
  });

  it('rejects at the deadline and aborts the operation\'s signal, even if the operation ignores it', async () => {
    let operationSignal: AbortSignal | undefined;
    const result = withTimeout(async signal => {
      operationSignal = signal;

      return await new Promise<never>(() => undefined);
    }, { timeoutMs: 1_000 });
    const assertion = expect(result).rejects.toBeInstanceOf(TimeoutError);

    await vi.advanceTimersByTimeAsync(999);
    expect(operationSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(operationSignal?.reason).toBeInstanceOf(TimeoutError);
  });

  it('aborts when the caller\'s signal aborts', async () => {
    const controller = new AbortController();
    let operationSignal: AbortSignal | undefined;
    const result = withTimeout(async signal => {
      operationSignal = signal;

      return await new Promise<never>(() => undefined);
    }, { timeoutMs: 1_000, signal: controller.signal });
    const assertion = expect(result).rejects.toThrow('client gone');

    controller.abort(new Error('client gone'));
    await assertion;
    expect(operationSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('doesn\'t start when the caller\'s signal has already aborted', async () => {
    const operation = vi.fn(async () => 'done');

    await expect(withTimeout(operation, { timeoutMs: 1_000, signal: AbortSignal.abort(new Error('early')) })).rejects.toThrow('early');
    expect(operation).not.toHaveBeenCalled();
  });
});
