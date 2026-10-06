import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { servedDocumentKinds, type AgentDocsService } from './service.js';

const mediaTypes = {
  'openapi.json': 'application/json; charset=utf-8',
  'llms.txt': 'text/plain; charset=utf-8',
  'skill.md': 'text/markdown; charset=utf-8',
} as const;

/**
 * A live service's agent documents, without a key (AD-1, AD-2, AD-4, AR1, PA-2):
 * `GET /v1/services/{id}/openapi.json`, `…/llms.txt`, and `…/skill.md`, with an ETag. Limited per
 * client IP (PA-5).
 */
export const registerAgentDocRoutes = (app: FastifyInstance, { docs, limit }: { readonly docs: AgentDocsService; readonly limit: onRequestHookHandler }): void => {
  for (const kind of servedDocumentKinds) {
    app.get<{ Params: { readonly id: string } }>(`/v1/services/:id/${kind}`, { onRequest: limit }, async (request, reply) => {
      const document = await docs.find(request.params.id, kind);
      reply.header('etag', document.etag).header('cache-control', 'public, max-age=60, must-revalidate');
      const match = request.headers['if-none-match'];
      if (typeof match === 'string' && match.split(',').map(tag => tag.trim()).includes(document.etag))
        return reply.status(304).send();

      return reply.type(mediaTypes[kind]).send(document.content);
    });
  }
};
