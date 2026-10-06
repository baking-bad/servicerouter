import { isRecord } from '@servicerouter/common';

/** Where a host publishes its ownership file (OV-2): `https://<host>/.well-known/servicerouter.json`. */
export const ownershipFilePath = '/.well-known/servicerouter.json';

export const ownershipFileUrl = (host: string): string => `https://${host}${ownershipFilePath}`;

// The file is small: a few tokens and service links (OV-2)
export const ownershipFileLimits = {
  maxBytes: 64 * 1024,
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 10_000,
} as const;

const maxTokens = 100;
const maxTokenLength = 256;

/** The parts of the file the platform reads. `services` is for agents, so it isn't kept. */
export interface OwnershipFile {
  readonly version: 1;
  readonly verification: readonly string[];
  // `false` blocks payment routing to the host (RT-2). Absent means allowed.
  readonly routing: boolean | undefined;
}

export type ParseOwnershipFileResult =
  | { readonly ok: true; readonly file: OwnershipFile }
  // A fixed reason, never anything quoted from the file
  | { readonly ok: false; readonly reason: string };

const invalid = (reason: string): ParseOwnershipFileResult => ({ ok: false, reason });

/**
 * Parses an ownership file (OV-2, OV-8): JSON with `version: 1` and a `verification` list of strings,
 * an optional `services` list, and an optional boolean `routing`. Unknown fields are ignored, so a
 * later version can add some. Payment routing's opt-out check uses the same parser (RT-2).
 */
export const parseOwnershipFile = (bytes: Uint8Array | string): ParseOwnershipFileResult => {
  let value: unknown;
  try {
    value = JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8'));
  }
  catch {
    return invalid('the file isn\'t valid JSON');
  }
  if (!isRecord(value))
    return invalid('the file isn\'t a JSON object');
  if (value['version'] !== 1)
    return invalid('version must be 1');

  const verification = value['verification'];
  if (!Array.isArray(verification))
    return invalid('verification must be a list of tokens');
  if (verification.length > maxTokens)
    return invalid(`verification lists more than ${maxTokens} tokens`);
  if (!verification.every(token => typeof token === 'string' && token.length <= maxTokenLength))
    return invalid(`each verification token must be a string of at most ${maxTokenLength} characters`);

  const services = value['services'];
  if (services !== undefined && !Array.isArray(services))
    return invalid('services must be a list');

  const routing = value['routing'];
  if (routing !== undefined && typeof routing !== 'boolean')
    return invalid('routing must be true or false');

  return { ok: true, file: { version: 1, verification: verification as string[], routing } };
};
