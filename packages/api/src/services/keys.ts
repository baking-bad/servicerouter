import { InvalidEnvironmentError, type AppEnvironment } from '@servicerouter/common';
import { createSecretSealer, SecretKeyInvalidError, type SecretSealer } from '@servicerouter/core';

export const secretsPublicKeyVariable = 'SECRETS_PUBLIC_KEY';

const keygenHint = 'Generate a pair with node scripts/secrets-keygen.mjs';

/**
 * The sealer from `SECRETS_PUBLIC_KEY`: the PEM public key of the proxy's secrets pair (SC-2, S2-D4).
 * A literal `\n` becomes a newline, so the key fits on one `.env` line. Throws InvalidEnvironmentError
 * with the reason when the key is missing or the sealer can't use it.
 */
export const readSecretsSealer = (env: AppEnvironment): SecretSealer => {
  const value = env[secretsPublicKeyVariable]?.trim();
  if (!value)
    throw new InvalidEnvironmentError(`${secretsPublicKeyVariable} is not set. It holds the PEM public key that seals seller secrets. ${keygenHint}`);

  try {
    return createSecretSealer(value.replaceAll('\\n', '\n'));
  }
  catch (error) {
    if (error instanceof SecretKeyInvalidError)
      throw new InvalidEnvironmentError(`${secretsPublicKeyVariable} can't seal secrets: ${error.message}. ${keygenHint}`);
    throw error;
  }
};
