import type { FastifyInstance } from 'fastify';

import type { Logger } from '../logging.js';
import { withTimeout } from '../timeout.js';

export const healthPath = '/_/health';
export const readinessPath = '/_/ready';

const defaultReadinessTimeoutMs = 2_000;

/** One dependency readiness covers, such as Postgres. `check` throws or rejects when it isn't ready. */
export interface ReadinessCheck {
  readonly name: string;
  check(signal: AbortSignal): Promise<void>;
}

export type ReadinessStatus = 'ok' | 'failed';

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, ReadinessStatus>>;
}

export interface ReadinessOptions {
  readonly checks: readonly ReadinessCheck[];
  readonly logger: Pick<Logger, 'warn'>;
  // Each check's deadline (CK-7). Default: 2 s.
  readonly timeoutMs?: number;
}

/** Runs every check at once, each under its own deadline, and reports which failed (XC-3). */
export const checkReadiness = async ({
  checks,
  logger,
  timeoutMs = defaultReadinessTimeoutMs,
}: ReadinessOptions): Promise<ReadinessReport> => {
  const results = await Promise.all(checks.map(async ({ name, check }): Promise<readonly [string, ReadinessStatus]> => {
    try {
      await withTimeout(check, { timeoutMs });

      return [name, 'ok'];
    }
    catch (error) {
      // The reason goes to the log only. The response says which check failed, nothing more.
      logger.warn({ check: name, error }, 'Readiness check failed');

      return [name, 'failed'];
    }
  }));

  return {
    ready: results.every(([, status]) => status === 'ok'),
    checks: Object.fromEntries(results),
  };
};

/** `/_/health` answers while the process runs. `/_/ready` answers 200 or 503 from the checks. */
export const registerHealthRoutes = (app: FastifyInstance, { checks, timeoutMs }: Omit<ReadinessOptions, 'logger'>): void => {
  app.get(healthPath, async () => ({ status: 'ok' }));
  app.get(readinessPath, async (request, reply) => {
    const { ready, checks: statuses } = await checkReadiness({ checks, logger: request.log, timeoutMs });

    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'not_ready', checks: statuses });
  });
};
