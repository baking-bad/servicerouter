import { InvalidEnvironmentError, readSecret, Secret, type AppEnvironment } from '@servicerouter/common';
import { createSecretOpener, SecretKeyInvalidError, type SecretOpener } from '@servicerouter/core';

export const secretsPrivateKeysVariable = 'SECRETS_PRIVATE_KEYS';

const pemBlock = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const keygenHint = 'Generate a pair with node scripts/secrets-keygen.mjs';

/**
 * The opener from `SECRETS_PRIVATE_KEYS`: one or more PEM private keys, one after another, so the pair
 * can rotate (SC-2, SC-4, S2-D4). A literal `\n` becomes a newline, so the keys fit on one `.env` line.
 * Each key stays in a Secret. Throws InvalidEnvironmentError with the reason, never quoting a key.
 */
export const readSecretsOpener = (env: AppEnvironment): SecretOpener => {
  if (!env[secretsPrivateKeysVariable]?.trim())
    throw new InvalidEnvironmentError(`${secretsPrivateKeysVariable} is not set. It holds the PEM private keys that open seller secrets. ${keygenHint}`);

  const value = readSecret(secretsPrivateKeysVariable, env);
  const keys = (value.expose().replaceAll('\\n', '\n').match(pemBlock) ?? []).map(block => Secret.from(block));
  value.destroy();
  if (keys.length === 0)
    throw new InvalidEnvironmentError(`${secretsPrivateKeysVariable} holds no PEM key. ${keygenHint}`);

  try {
    return createSecretOpener(keys);
  }
  catch (error) {
    if (error instanceof SecretKeyInvalidError)
      throw new InvalidEnvironmentError(`${secretsPrivateKeysVariable} can't open secrets: ${error.message}. ${keygenHint}`);
    throw error;
  }
  finally {
    for (const key of keys)
      key.destroy();
  }
};
