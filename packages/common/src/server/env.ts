import { ServiceRouterError } from '../errors.js';

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
