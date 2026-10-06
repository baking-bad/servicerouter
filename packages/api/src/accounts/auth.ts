import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { Secret } from '@servicerouter/common';
import {
  hashApiKey, InvalidKeyError, isWellFormedKey, keyKindOf, UnauthorizedError, WrongKeyTypeError, type ApiKeyRepository,
  type KeyPrefixes,
} from '@servicerouter/core';

/** Who an authenticated request comes from: the account, and the master key it used. */
export interface AuthenticatedAccount {
  readonly accountId: string;
  readonly keyId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    // Set by the master key hook on account endpoints (PA-2). Read it with `authenticatedAccount`.
    account: AuthenticatedAccount | undefined;
  }
}

export interface MasterKeyAuthOptions {
  readonly keyPrefixes: KeyPrefixes;
  readonly apiKeys: Pick<ApiKeyRepository, 'findActiveByHash'>;
}

const bearerPattern = /^Bearer[ \t]+(\S+)[ \t]*$/i;

// A 401 names the scheme it expects
const refuse = (reply: FastifyReply, error: Error): Error => {
  reply.header('www-authenticate', 'Bearer');

  return error;
};

/** Lets requests carry `account`. Call once on the root app, before any route. */
export const decorateAccount = (app: FastifyInstance): void => {
  app.decorateRequest('account', undefined);
};

/**
 * The `onRequest` hook for every account endpoint (PA-2, AK-4). Reads `Authorization: Bearer <key>`:
 * - no Bearer key: `401 unauthorized`;
 * - a payment key, told by its prefix before any lookup: `401 wrong_key_type`;
 * - anything else that isn't a well-formed master key: `401 invalid_key`, without a lookup;
 * - a master key whose hash isn't active in `api_keys`: `401 invalid_key`.
 * There is no cache: every request looks the hash up, so a rotation applies at once (AK-9).
 */
export const createMasterKeyAuth = ({ keyPrefixes, apiKeys }: MasterKeyAuthOptions) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerPattern.exec(request.headers.authorization ?? '')?.[1];
    if (token === undefined)
      throw refuse(reply, new UnauthorizedError());

    const kind = keyKindOf(token, keyPrefixes);
    if (kind === 'payment')
      throw refuse(reply, new WrongKeyTypeError('A payment key works only on the proxy. The Platform API takes the master key.'));
    if (kind !== 'master' || !isWellFormedKey(token, kind, keyPrefixes))
      throw refuse(reply, new InvalidKeyError());

    const key = Secret.from(token);
    let keyHash: string;
    try {
      keyHash = hashApiKey(key);
    }
    finally {
      key.destroy();
    }
    const record = await apiKeys.findActiveByHash(keyHash);
    if (record?.kind !== 'master')
      throw refuse(reply, new InvalidKeyError());

    request.account = { accountId: record.accountId, keyId: record.id };
  };

/** The account of a request that passed the master key hook. */
export const authenticatedAccount = (request: FastifyRequest): AuthenticatedAccount => {
  if (!request.account)
    throw new Error('The route has no master key hook');

  return request.account;
};
