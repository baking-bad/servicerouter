import { InvalidEnvironmentError, readSecret, type AppEnvironment, type Secret } from '@servicerouter/common';

export const internalSecretVariable = 'INTERNAL_API_SECRET';
// Long enough that guessing it over the network is hopeless
export const minimumInternalSecretLength = 32;

/** INTERNAL_API_SECRET, the internal API's shared secret (PA-4). Throws when it is missing or shorter than 32 characters. */
export const readInternalSecret = (env: AppEnvironment): Secret => {
  const secret = readSecret(internalSecretVariable, env);
  if (secret.expose().length < minimumInternalSecretLength) {
    secret.destroy();
    throw new InvalidEnvironmentError(`${internalSecretVariable} must be at least ${minimumInternalSecretLength} characters`);
  }

  return secret;
};
