import type { Logger } from 'pino';

const defaultShutdownTimeoutMs = 30_000;

export interface ShutdownHandlerOptions {
  // Stops accepting work and runs the app's shutdown hooks
  readonly dispose: () => Promise<void>;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly exit?: (code: number) => void;
}

export type ShutdownHandler = (signal: string) => Promise<void>;

export const createShutdownHandler = ({
  dispose,
  logger,
  timeoutMs = defaultShutdownTimeoutMs,
  exit = code => process.exit(code),
}: ShutdownHandlerOptions): ShutdownHandler => {
  let isShuttingDown = false;

  return async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress');
      return;
    }

    isShuttingDown = true;
    logger.info({ signal }, 'Shutdown initiated');

    const timeoutId = setTimeout(() => {
      logger.error('Shutdown timeout exceeded, forcing exit');
      exit(1);
    }, timeoutMs);

    let exitCode: 0 | 1 = 0;
    try {
      await dispose();
    }
    catch (error) {
      logger.error({ error }, 'Error during shutdown');
      exitCode = 1;
    }

    clearTimeout(timeoutId);
    exit(exitCode);
  };
};

export const registerShutdownHandler = (shutdown: ShutdownHandler, logger: Logger): void => {
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('uncaughtException', error => {
    logger.fatal({ error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });

  process.on('unhandledRejection', reason => {
    // Under `error`, so the reason gets the error serializer's safe fields (L-9)
    logger.fatal({ error: reason }, 'Unhandled rejection');
    void shutdown('unhandledRejection');
  });
};
