import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { DocumentError, OutboundHttpError, outboundFields, parseStrictYaml, type OutboundHttp, type ValidationIssue } from '@servicerouter/common';
import { draftServiceConfig, openApiFetchLimits, RateLimitedError, type LlmDrafter, type PlatformConfig, type RateLimiter } from '@servicerouter/core';

import { authenticatedAccount } from '../accounts/auth.js';
import { InvalidRequestError } from '../errors.js';

const draftBodySchema = {
  type: 'object',
  required: ['openapi', 'payoutAddress'],
  properties: {
    // The seller's OpenAPI link (CA-1)
    openapi: { type: 'string', pattern: '^https://', maxLength: 2048 },
    // Where the seller is paid: a draft never carries an address nobody controls
    payoutAddress: { type: 'string', minLength: 1, maxLength: 256 },
    id: { type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' },
  },
  additionalProperties: false,
} as const;

interface DraftBody {
  readonly openapi: string;
  readonly payoutAddress: string;
  readonly id?: string;
}

const toDetail = ({ path, line, column, message }: ValidationIssue) => ({ path, line: line ?? null, column: column ?? null, message });

/** A problem that names the host and what went wrong, never anything from the response (CA-4, SR-3). */
class DraftFailedError extends InvalidRequestError {}

/**
 * `POST /v1/assistant/drafts` (CA-1 to CA-4), behind the master key: fetches the OpenAPI document
 * through Outbound HTTP, drafts a config, validates it as a submit would, and returns it. Nothing is
 * stored, submitted, or activated. Limited per account.
 */
export const registerAssistantRoutes = (app: FastifyInstance, { http, platform, drafter, limiter, authenticate }: {
  readonly http: Pick<OutboundHttp, 'request'>;
  readonly platform: PlatformConfig;
  readonly drafter: LlmDrafter;
  readonly limiter: RateLimiter;
  readonly authenticate: onRequestHookHandler;
}): void => {
  app.register(async scope => {
    scope.addHook('onRequest', authenticate);
    scope.post<{ Body: DraftBody }>('/v1/assistant/drafts', { schema: { body: draftBodySchema } }, async (request, reply) => {
      const { accountId } = authenticatedAccount(request);
      const { allowed, retryAfterSeconds } = await limiter.hit(`api:assistant:${accountId}`, platform.rateLimits.assistant);
      if (!allowed) {
        reply.header('retry-after', String(retryAfterSeconds));
        throw new RateLimitedError(retryAfterSeconds);
      }

      const { openapi, payoutAddress, id } = request.body;
      // L-7: each draft's outcome, with the document's host and path, never its query or content (L-4)
      const started = performance.now();
      const drafted = (result: string, extra: Record<string, unknown> = {}): void => {
        request.log.info({ accountId, result, ...extra }, 'A config draft was requested');
      };
      const fetchFields = (outcome: { readonly status?: number; readonly error?: unknown }) =>
        outboundFields({ url: openapi, method: 'GET', ...outcome, durationMs: performance.now() - started });
      let document: unknown;
      try {
        const response = await http.request({
          url: openapi, redirect: 'sameHost', headers: { accept: 'application/json, application/yaml;q=0.9' },
          totalTimeoutMs: openApiFetchLimits.totalTimeoutMs, maxResponseBytes: openApiFetchLimits.maxBytes,
        });
        if (response.status < 200 || response.status > 299) {
          response.dispose();
          drafted('fetch_failed', fetchFields({ status: response.status }));
          throw new DraftFailedError(`The OpenAPI document can't be fetched: ${response.url.hostname} answered with status ${response.status}`);
        }
        document = parseStrictYaml(await response.bytes(), { maxBytes: openApiFetchLimits.maxBytes }).value;
      }
      catch (error) {
        if (error instanceof OutboundHttpError) {
          drafted('fetch_failed', fetchFields({ error }));
          throw new DraftFailedError(`The OpenAPI document can't be fetched: ${error.message}`);
        }
        if (error instanceof DocumentError) {
          drafted('unparseable', fetchFields({}));
          throw new DraftFailedError(`The OpenAPI document doesn't parse: ${error.reason}`);
        }
        throw error;
      }

      const result = await draftServiceConfig({ document, link: openapi, platform, drafter, payoutAddress, ...id ? { serviceId: id } : {} });
      if (!result.ok) {
        drafted('invalid_config', { ...fetchFields({}), problems: result.errors.length });
        return reply.status(400).send({
          error: { code: 'invalid_config', message: 'The draft doesn\'t pass validation: check the payout address and the document', details: result.errors.map(toDetail) },
        });
      }
      drafted('drafted', { ...fetchFields({}), serviceId: result.draft.serviceId, warnings: result.draft.warnings.length });

      return {
        id: result.draft.serviceId,
        config: { mediaType: 'application/yaml', text: result.draft.yaml },
        warnings: result.draft.warnings.map(toDetail),
        notes: result.draft.notes,
        submitted: false,
      };
    });
  });
};
