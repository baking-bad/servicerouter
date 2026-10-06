import { InvalidEnvironmentError, readSecret, type AppEnvironment, type Secret } from '@servicerouter/common';

export const mppSecretKeyVariable = 'MPP_SECRET_KEY';
// mppx's minimum for the challenges' HMAC key
export const minimumMppSecretKeyBytes = 32;

/**
 * MPP_SECRET_KEY, the HMAC key that binds each MPP challenge to its contents (PR-9). The same on every
 * replica. Throws when it is missing or shorter than 32 bytes.
 */
export const readMppSecretKey = (env: AppEnvironment): Secret => {
  const key = readSecret(mppSecretKeyVariable, env);
  if (Buffer.byteLength(key.expose(), 'utf8') < minimumMppSecretKeyBytes) {
    key.destroy();
    throw new InvalidEnvironmentError(`${mppSecretKeyVariable} must be at least ${minimumMppSecretKeyBytes} bytes. Generate one with: openssl rand -base64 32`);
  }

  return key;
};
