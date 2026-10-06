import type { FastifyInstance } from 'fastify';

import { InvalidEnvironmentError, type AppEnvironment } from '@servicerouter/common';

// PA-7: the console on the website calls the Platform API from the browser (WB-8). Only the website's
// origin, and origins named for local development, get CORS headers. No cookies: the master key goes in
// Authorization.

export const corsOriginsVariable = 'CORS_ORIGINS';
const preflightHeaders = {
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-max-age': '600',
} as const;

/** The website's origin, and the origins in CORS_ORIGINS (comma-separated), such as http://localhost:3000. */
export const readCorsOrigins = (env: AppEnvironment, website: string): readonly string[] => {
  const extra = (env[corsOriginsVariable] ?? '').split(',').map(origin => origin.trim()).filter(origin => origin !== '');
  for (const origin of extra) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    }
    catch {
      throw new InvalidEnvironmentError(`${corsOriginsVariable} holds "${origin}", which isn't an origin such as http://localhost:3000`);
    }
    if (parsed.origin !== origin)
      throw new InvalidEnvironmentError(`${corsOriginsVariable} holds "${origin}", which isn't an origin such as http://localhost:3000`);
  }

  return [new URL(website).origin, ...extra];
};

/** Answers the allowed origins' preflights with 204, and lets them read every answer, errors included. */
export const registerCors = (app: FastifyInstance, origins: readonly string[]): void => {
  const allowed = new Set(origins);
  app.addHook('onRequest', async (request, reply) => {
    const { origin } = request.headers;
    if (origin === undefined || !allowed.has(origin))
      return undefined;

    reply.headers({ 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-expose-headers': 'x-request-id' });
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined)
      return reply.status(204).headers(preflightHeaders).send();

    return undefined;
  });
};
