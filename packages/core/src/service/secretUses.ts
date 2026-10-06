import type { ServiceConfigDocument } from './document.js';

/** An upstream that sends a secret, through a credential in its `auth`. */
export interface SecretUse {
  // Index in `upstreams`
  readonly upstream: number;
  // `new URL(baseUrl).origin`, which the secret is sealed for (SC-10)
  readonly origin: string;
}

const originOf = (baseUrl: string): string | undefined => {
  try {
    return new URL(baseUrl).origin;
  }
  catch {
    return undefined;
  }
};

/**
 * Which upstreams send each secret, by secret name, in config order (SC-10). Only secrets that an
 * upstream's `auth` reaches through a credential are used: anything else has no origin to be bound to.
 */
export const getSecretUses = (config: ServiceConfigDocument): ReadonlyMap<string, readonly SecretUse[]> => {
  const credentials = config.credentials ?? {};
  const uses = new Map<string, SecretUse[]>();
  for (const [index, upstream] of config.upstreams.entries()) {
    const origin = originOf(upstream.baseUrl);
    const references = typeof upstream.auth === 'string' ? [upstream.auth] : upstream.auth ?? [];
    for (const reference of references) {
      const credential = Object.hasOwn(credentials, reference) ? credentials[reference] : undefined;
      if (origin === undefined || !credential)
        continue;

      const secretUses = uses.get(credential.secret) ?? [];
      if (!secretUses.some(use => use.upstream === index))
        secretUses.push({ upstream: index, origin });
      uses.set(credential.secret, secretUses);
    }
  }

  return uses;
};

/**
 * The origin each secret is sealed for: that of the upstreams that send it (SC-10). A secret sent to
 * several origins has no entry, since validation refuses it.
 */
export const getSecretOrigins = (config: ServiceConfigDocument): ReadonlyMap<string, string> =>
  new Map([...getSecretUses(config)].flatMap(([secret, uses]) => {
    const origins = new Set(uses.map(use => use.origin));

    return origins.size === 1 ? [[secret, uses[0]!.origin] as const] : [];
  }));

/**
 * Stored secrets whose origin isn't the one this config sends them to, by name, sorted: they would
 * no longer open in the proxy (SC-10). `stored` maps each stored secret to its origin.
 */
export const findMovedSecrets = (config: ServiceConfigDocument, stored: ReadonlyMap<string, string>): readonly string[] =>
  [...getSecretUses(config)]
    .filter(([secret, uses]) => stored.has(secret) && uses.some(use => use.origin !== stored.get(secret)))
    .map(([secret]) => secret)
    .sort();
