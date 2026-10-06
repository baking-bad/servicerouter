import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { InvalidKeyError, type Account } from '@servicerouter/core';

import type { AccountDeposit, DepositService } from '../deposits/service.js';
import { authenticatedAccount } from './auth.js';
import type { AccountService } from './service.js';

export const lostKeyNotice = 'Store the master key now: it is shown only once. Without a confirmed email, '
  + 'a lost master key can\'t be recovered, and the account is lost with it.';

const signupBodySchema = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email', maxLength: 254 },
  },
  additionalProperties: false,
} as const;

interface SignupBody {
  readonly email?: string;
}

export interface AccountRoutesOptions {
  readonly accounts: AccountService;
  // The master key hook (PA-2)
  readonly authenticate: onRequestHookHandler;
  // The per-IP signup limit (PA-5)
  readonly signupLimit: onRequestHookHandler;
  // The deposit address and top-up link (AK-1, DP-1)
  readonly deposits: Pick<DepositService, 'ensure'>;
}

// A confirmed email arrives after the MVP (AR19). The top-up link and deposit address are null while deposits are off.
const toAccountBody = (account: Account, deposit: AccountDeposit | undefined) => ({
  id: account.id,
  email: account.email ?? null,
  emailConfirmed: account.emailConfirmedAt !== undefined,
  topupUrl: deposit?.topupUrl ?? null,
  depositAddress: deposit ? { address: deposit.address, network: deposit.network, asset: deposit.asset } : null,
  createdAt: account.createdAt.toISOString(),
});

/**
 * `POST /v1/accounts` (AK-1), and behind the master key, `GET /v1/account` (AK-2) and
 * `POST /v1/account/master-key/rotate` (AK-5). A key appears once, in the response that creates it.
 */
export const registerAccountRoutes = (app: FastifyInstance, { accounts, authenticate, signupLimit, deposits }: AccountRoutesOptions): void => {
  app.post<{ Body: SignupBody | undefined }>('/v1/accounts', {
    onRequest: signupLimit,
    // No body is the same as an empty one
    preValidation: async request => {
      request.body ??= {};
    },
    schema: { body: signupBodySchema },
  }, async (request, reply) => {
    const { account, masterKey } = await accounts.create({ email: request.body?.email, requestId: request.id });
    const key = masterKey.expose();
    masterKey.destroy();
    // From step 9, signup also creates the deposit address and top-up link (AK-1). A failure here leaves
    // the account without one, and the next GET /v1/account creates it.
    let deposit: AccountDeposit | undefined;
    try {
      deposit = await deposits.ensure(account.id);
    }
    catch (error) {
      request.log.error({ error, accountId: account.id }, 'Failed to create a deposit address at signup');
    }

    return reply
      .status(201)
      .header('cache-control', 'no-store')
      .send({ ...toAccountBody(account, deposit), masterKey: key, notice: lostKeyNotice });
  });

  app.register(async scope => {
    scope.addHook('onRequest', authenticate);

    scope.get('/v1/account', async request => {
      const account = await accounts.get(authenticatedAccount(request).accountId);
      // An active key always has its account
      if (!account)
        throw new InvalidKeyError();

      return toAccountBody(account, await deposits.ensure(account.id));
    });

    scope.post('/v1/account/master-key/rotate', async (request, reply) => {
      const { accountId, keyId } = authenticatedAccount(request);
      const masterKey = await accounts.rotateMasterKey({ accountId, keyId, requestId: request.id });
      const key = masterKey.expose();
      masterKey.destroy();

      return reply.header('cache-control', 'no-store').send({ masterKey: key });
    });
  });
};
