import type { ServerResponse } from 'node:http';

import type { RecordedRequest } from './upstream.js';

/** Ownership files served by a fake upstream at `/.well-known/servicerouter.json`, per host (OV-2). */
export interface FakeOwnershipFiles {
  /** Serves this JSON value as the host's file. */
  publish(host: string, file: unknown): void;
  /** Serves the file `{ version: 1, verification: tokens }`. */
  publishTokens(host: string, tokens: readonly string[]): void;
  /** Serves this raw answer instead, such as a status or an oversized body. */
  answer(host: string, answer: { readonly status: number; readonly body?: string | Buffer; readonly location?: string }): void;
  /** The host has no file: 404. */
  remove(host: string): void;
  /** Answers the request if it asks for an ownership file. Returns whether it did. */
  handle(request: RecordedRequest, response: ServerResponse): boolean;
  /** How many times each host's file was fetched. */
  fetches(host: string): number;
}

const filePath = '/.well-known/servicerouter.json';

export const createFakeOwnershipFiles = (): FakeOwnershipFiles => {
  const answers = new Map<string, { readonly status: number; readonly body?: string | Buffer; readonly location?: string }>();
  const counts = new Map<string, number>();

  return {
    publish: (host, file) => {
      answers.set(host, { status: 200, body: JSON.stringify(file) });
    },
    publishTokens: (host, tokens) => {
      answers.set(host, { status: 200, body: JSON.stringify({ version: 1, verification: tokens }) });
    },
    answer: (host, answer) => {
      answers.set(host, answer);
    },
    remove: host => {
      answers.delete(host);
    },
    handle: (request, response) => {
      if (request.path !== filePath)
        return false;

      const host = request.servername ?? String(request.headers.host ?? '').split(':')[0] ?? '';
      counts.set(host, (counts.get(host) ?? 0) + 1);
      const answer = answers.get(host) ?? { status: 404, body: 'BODY-MARKER-do-not-echo' };
      if (answer.location)
        response.setHeader('location', answer.location);
      response.setHeader('content-type', 'application/json');
      response.writeHead(answer.status).end(answer.body ?? '');

      return true;
    },
    fetches: host => counts.get(host) ?? 0,
  };
};
