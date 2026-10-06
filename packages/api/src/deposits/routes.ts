import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import type { DepositService } from './service.js';

export interface DepositRoutesOptions {
  readonly deposits: DepositService;
  // The per-IP limit of an endpoint without a key (PA-5)
  readonly topupLimit: onRequestHookHandler;
}

/** `GET /v1/topup/{token}` (DP-5): no key, the top-up token alone, which reveals the address and its deposits only (AK-15). */
export const registerDepositRoutes = (app: FastifyInstance, { deposits, topupLimit }: DepositRoutesOptions): void => {
  app.get<{ Params: { readonly token: string } }>('/v1/topup/:token', { onRequest: topupLimit }, async (request, reply) => {
    const topup = await deposits.topup(request.params.token);

    return reply.header('cache-control', 'no-store').send(topup);
  });
};
