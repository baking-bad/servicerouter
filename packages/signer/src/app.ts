import { createServer, type IdGenerator, type Logger, type Server } from '@servicerouter/common';

export interface SignerDependencies {
  readonly logger: Logger;
  // Request IDs for requests without one. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
}

/** The Signer, on the internal network only. No readiness checks yet. Signing arrives in step 12. */
export const createApp = ({ logger, requestIds }: SignerDependencies): Server => createServer({ logger, requestIds });
