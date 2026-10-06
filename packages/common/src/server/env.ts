import { ServiceRouterError } from '../errors.js';
import { logLevels, type LogLevel } from '../logging.js';

export type AppEnvironment = Readonly<Record<string, string | undefined>>;

export class InvalidEnvironmentError extends ServiceRouterError {
  readonly code = 'invalid_environment';
}

const defaultHost = '0.0.0.0';
const portPattern = /^\d{1,5}$/;

/** `HOST`, the address both listeners bind to. Default: every interface. */
export const readHost = (env: AppEnvironment): string => env['HOST']?.trim() || defaultHost;

/** A port from the environment, such as `PORT` or `METRICS_PORT`, or the app's default. */
export const readPort = (env: AppEnvironment, name: string, defaultPort: number): number => {
  const value = env[name]?.trim();
  if (!value)
    return defaultPort;

  const port = Number(value);
  if (!portPattern.test(value) || port > 65_535)
    throw new InvalidEnvironmentError(`${name} must be a port number from 0 to 65535`);

  return port;
};

/**
 * `LOG_LEVEL`, which overrides platform config's `logger.level`, so an operator can switch a running
 * stack to `debug` without a new config (L-11). Unset: the configured level.
 */
export const readLogLevel = (env: AppEnvironment, configured: LogLevel): LogLevel => {
  const value = env['LOG_LEVEL']?.trim().toLowerCase();
  if (!value)
    return configured;
  if (!(logLevels as readonly string[]).includes(value))
    throw new InvalidEnvironmentError(`LOG_LEVEL must be one of ${logLevels.join(', ')}`);

  return value as LogLevel;
};

const commitPattern = /^[0-9a-f]{7,40}$/i;

/** `GIT_SHA`, the commit the image was built from, for the startup line (L-1). Undefined outside an image. */
export const readCommit = (env: AppEnvironment): string | undefined => {
  const value = env['GIT_SHA']?.trim();

  return value && commitPattern.test(value) ? value.toLowerCase() : undefined;
};
