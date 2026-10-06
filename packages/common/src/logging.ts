import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import { redactedMessage } from './secret.js';

export type { Logger };

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

// JSON to stdout unless a destination is given
export const createLogger = (options: LoggerOptions<never, boolean> = {}, destination?: DestinationStream): Logger<never, boolean> => {
  const loggerOptions: LoggerOptions<never, boolean> = {
    serializers: {
      error: pino.stdSerializers.err,
    },
    redact: {
      paths: redactPaths,
      censor: redactedMessage,
    },
    ...options,
  };

  return destination ? pino(loggerOptions, destination) : pino(loggerOptions);
};
