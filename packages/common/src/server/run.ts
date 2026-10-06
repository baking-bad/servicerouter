import { createLogger, type Logger } from '../logging.js';
import { createShutdownHandler, registerShutdownHandler } from '../process.js';
import type { AppEnvironment } from './env.js';

export interface AppContext {
  readonly env: AppEnvironment;
  readonly logger: Logger;
}

/** A started app. `close` stops accepting, drains in-flight work, and closes its connections. */
export interface RunningApp {
  close(): Promise<void>;
}

export interface RunAppOptions {
  readonly name: string;
  /** Loads config, builds the app's dependencies, and starts listening. Throws if the app can't start. */
  readonly start: (context: AppContext) => Promise<RunningApp>;
  readonly env?: AppEnvironment;
  readonly logger?: Logger;
  readonly exit?: (code: number) => void;
}

/**
 * Runs an app's `main`. If it can't start, such as with an invalid platform config (PC-1), it logs the
 * reason and exits with 1. Once started, SIGINT and SIGTERM close it and exit (CK-6).
 */
export const runApp = async ({
  name,
  start,
  env = process.env,
  logger = createLogger({ name }),
  exit = code => process.exit(code),
}: RunAppOptions): Promise<void> => {
  let app: RunningApp;
  try {
    app = await start({ env, logger });
  }
  catch (error) {
    logger.fatal({ error }, 'Failed to start');
    exit(1);
    return;
  }

  registerShutdownHandler(createShutdownHandler({ dispose: () => app.close(), logger, exit }), logger);
};
