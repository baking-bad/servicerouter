import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import { serializeError } from './diagnostics.js';
import { redactedMessage } from './secret.js';

export type { Logger };

/** What a function that only writes lines needs: a request's logger, such as Fastify's `request.log`, or an app's. */
export type LogSink = Pick<Logger, 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'>;

// Request and response headers that carry credentials or payment data (CK-3)
export const redactedHeaders = [
  'authorization',
  'payment-signature',
  'x-payment',
  'payment-receipt',
  'payment-required',
  'payment-response',
  'www-authenticate',
  'cookie',
  'set-cookie',
] as const;

const redactPaths = [
  ...['req', 'res'].flatMap(side => redactedHeaders.map(header => `${side}.headers["${header}"]`)),
  '_hidden.*',
];

// The levels LOG_LEVEL and platform config's logger.level may name, `silent` included (L-11)
export const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = typeof logLevels[number];

// JSON to stdout unless a destination is given. An error under `error` or `err` keeps its safe fields only (L-9).
export const createLogger = (options: LoggerOptions<never, boolean> = {}, destination?: DestinationStream): Logger<never, boolean> => {
  const loggerOptions: LoggerOptions<never, boolean> = {
    serializers: {
      error: serializeError,
      err: serializeError,
    },
    redact: {
      paths: redactPaths,
      censor: redactedMessage,
    },
    ...options,
  };

  return destination ? pino(loggerOptions, destination) : pino(loggerOptions);
};
