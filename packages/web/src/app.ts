import { createServer, type IdGenerator, type Logger, type Server } from '@servicerouter/common';
import type { PlatformConfig } from '@servicerouter/core';

export interface WebDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  // Request IDs for requests without one. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
}

/** The website on servicerouter.ai. No readiness checks yet. Pages arrive in step 9 (AR11). */
export const createApp = ({ logger, requestIds }: WebDependencies): Server => createServer({ logger, requestIds });
