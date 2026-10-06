import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { createErrorHandler, Secret, type ValidationIssue } from '@servicerouter/common';
import { InvalidServiceConfigError, isSecretName } from '@servicerouter/core';

import { authenticatedAccount } from '../accounts/auth.js';
import { errorStatuses, InvalidRequestError } from '../errors.js';
import { findSecretValueProblem, jsonMediaType, parseSubmitBody, submitBodyLimit, yamlMediaTypes } from './body.js';
import type { ServiceRegistry } from './service.js';

export interface ServiceRoutesOptions {
  readonly registry: ServiceRegistry;
  // The master key hook (PA-2)
  readonly authenticate: onRequestHookHandler;
}

interface ServiceParams {
  readonly id: string;
}

interface SecretParams extends ServiceParams {
  readonly name: string;
}

const rollbackBodySchema = {
  type: 'object',
  required: ['revision'],
  properties: { revision: { type: 'integer', minimum: 1 } },
  additionalProperties: false,
} as const;

// The value's own rules are checked by hand, so no message can quote it
const secretBodySchema = {
  type: 'object',
  required: ['value'],
  properties: { value: { type: 'string' } },
  additionalProperties: false,
} as const;

/** A config problem as the API shows it (PA-3): always a line and column, null when the config had no text. */
const toDetail = ({ path, line, column, message }: ValidationIssue) => ({ path, line: line ?? null, column: column ?? null, message });

const handleError = createErrorHandler(errorStatuses);

/**
 * Behind the master key: `PUT /v1/services/{id}` (SR-12), `GET /v1/services/{id}`,
 * `GET /v1/services/{id}/revisions`, `POST /v1/services/{id}/rollback` (SR-7), and
 * `PUT /v1/services/{id}/secrets/{name}` (SC-1). No response carries a secret value, hash, or length.
 */
export const registerServiceRoutes = (app: FastifyInstance, { registry, authenticate }: ServiceRoutesOptions): void => {
  app.register(async scope => {
    scope.addHook('onRequest', authenticate);
    // invalid_config carries every problem in `details`, and the warnings (PA-3, SR-2)
    scope.setErrorHandler((error, request, reply) => error instanceof InvalidServiceConfigError
      ? reply.status(errorStatuses[error.code]).send({
        error: { code: error.code, message: error.message, details: error.issues.map(toDetail), warnings: error.warnings.map(toDetail) },
      })
      : handleError(error, request, reply));

    // The submit reads its body raw: the envelope's secrets come out before anything parses the config (SC-9)
    scope.register(async submit => {
      submit.removeAllContentTypeParsers();
      submit.addContentTypeParser([jsonMediaType, ...yamlMediaTypes], { parseAs: 'buffer', bodyLimit: submitBodyLimit }, (_request, body, done) => {
        done(null, body);
      });

      submit.put<{ Params: ServiceParams }>('/v1/services/:id', { bodyLimit: submitBodyLimit }, async (request, reply) => {
        const { accountId } = authenticatedAccount(request);
        const body = parseSubmitBody(request.body, request.headers['content-type']);
        const result = await registry.submit({ accountId, serviceId: request.params.id, requestId: request.id, body });

        return reply.status(result.created ? 201 : 200).send({
          id: request.params.id,
          revision: result.revision,
          changed: result.changed,
          state: result.state,
          warnings: result.warnings.map(toDetail),
        });
      });
    });

    scope.get<{ Params: ServiceParams }>('/v1/services/:id', async request => {
      const { accountId } = authenticatedAccount(request);
      const { service, revision, submitted, secrets } = await registry.get({ accountId, serviceId: request.params.id });

      return {
        id: service.id,
        state: service.state,
        revision,
        config: { mediaType: submitted.mediaType, text: submitted.text },
        secrets: secrets.map(secret => ({ name: secret.name, updatedAt: secret.updatedAt.toISOString() })),
        createdAt: service.createdAt.toISOString(),
        updatedAt: service.updatedAt.toISOString(),
      };
    });

    scope.get<{ Params: ServiceParams }>('/v1/services/:id/revisions', async request => {
      const { accountId } = authenticatedAccount(request);
      const { activeRevision, revisions } = await registry.listRevisions({ accountId, serviceId: request.params.id });

      return {
        revisions: revisions.map(revision => ({
          number: revision.number,
          active: revision.number === activeRevision,
          mediaType: revision.mediaType,
          createdBy: revision.createdBy,
          createdAt: revision.createdAt.toISOString(),
        })),
      };
    });

    scope.post<{ Params: ServiceParams; Body: { readonly revision: number } }>('/v1/services/:id/rollback', {
      schema: { body: rollbackBodySchema },
    }, async request => {
      const { accountId } = authenticatedAccount(request);
      const result = await registry.rollback({ accountId, serviceId: request.params.id, requestId: request.id, revision: request.body.revision });

      return { id: request.params.id, revision: result.revision, changed: result.changed, state: result.state };
    });

    scope.put<{ Params: SecretParams; Body: { readonly value: string } }>('/v1/services/:id/secrets/:name', {
      schema: { body: secretBodySchema },
    }, async request => {
      const { accountId } = authenticatedAccount(request);
      const { id, name } = request.params;
      if (!isSecretName(name))
        throw new InvalidRequestError('The secret name must be 1–64 lowercase letters, digits, hyphens, or underscores');

      const problem = findSecretValueProblem(name, request.body.value);
      if (problem)
        throw new InvalidRequestError(problem);

      const written = await registry.putSecret({ accountId, serviceId: id, requestId: request.id, name, value: Secret.from(request.body.value) });

      return { name: written.name, updatedAt: written.updatedAt.toISOString() };
    });
  });
};
