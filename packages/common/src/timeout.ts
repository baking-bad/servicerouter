import { ServiceRouterError } from './errors.js';

export class TimeoutError extends ServiceRouterError {
  readonly code = 'timeout';
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`The operation timed out after ${timeoutMs} ms`);

    this.timeoutMs = timeoutMs;
  }
}

export interface TimeoutOptions {
  readonly timeoutMs: number;
  // Aborts the operation early, for example when the client disconnects
  readonly signal?: AbortSignal;
}

/**
 * Runs an operation with a deadline (CK-7). The operation receives a signal that aborts when the
 * deadline passes or the caller's signal aborts, so it can cancel its own I/O. The returned promise
 * settles no later than the deadline, even if the operation ignores the signal.
 */
export const withTimeout = async <TResult>(
  operation: (signal: AbortSignal) => Promise<TResult>,
  { timeoutMs, signal }: TimeoutOptions,
): Promise<TResult> => {
  signal?.throwIfAborted();

  const controller = new AbortController();
  let rejectDeadline: (reason: unknown) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const fail = (reason: unknown) => {
    controller.abort(reason);
    rejectDeadline(reason);
  };
  const onAbort = () => fail(signal?.reason);
  const timeout = setTimeout(() => fail(new TimeoutError(timeoutMs)), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  }
  finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
};
