import { isServiceId } from '@servicerouter/common';

import { SecretBindingInvalidError } from './ports.js';

// Secret names in a service config (`credentials.<name>.secret`) and in the secrets API
export const secretNamePattern = '^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$';
const secretNameRegExp = new RegExp(secretNamePattern);

export const isSecretName = (value: string): boolean => secretNameRegExp.test(value);

/**
 * Whether `value` is an HTTPS origin in the form `new URL(baseUrl).origin` gives, such as
 * `https://api.example.com` or `https://api.example.com:8443`: lowercase, no path, no default port.
 */
export const isHttpsOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);

    return url.protocol === 'https:' && url.origin === value;
  }
  catch {
    return false;
  }
};

export interface SecretBinding {
  readonly serviceId: string;
  readonly name: string;
  readonly origin: string;
}

/** Why a sealed secret can't be bound to this service, name, and origin (SC-3, SC-10), or undefined. */
export const findBindingProblem = ({ serviceId, name, origin }: SecretBinding): string | undefined => {
  if (typeof serviceId !== 'string' || !isServiceId(serviceId))
    return 'The service ID is not valid';
  if (typeof name !== 'string' || !isSecretName(name))
    return 'The secret name must be 1–64 lowercase letters, digits, hyphens, or underscores';
  if (typeof origin !== 'string' || !isHttpsOrigin(origin))
    return 'The origin must be an HTTPS origin, such as https://api.example.com';

  return undefined;
};

/** Throws SecretBindingInvalidError for a malformed service ID, secret name, or origin. */
export const assertValidBinding = (binding: SecretBinding): void => {
  const problem = findBindingProblem(binding);
  if (problem)
    throw new SecretBindingInvalidError(problem);
};
