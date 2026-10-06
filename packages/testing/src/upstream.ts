import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

import { createTestCertificate } from './certificate.js';

export interface RecordedRequest {
  readonly method: string;
  // Path and query, as received
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  // The TLS server name the client sent (SNI)
  readonly servername: string | undefined;
}

export type UpstreamHandler = (request: RecordedRequest, response: ServerResponse) => void | Promise<void>;

export interface FakeUpstream {
  readonly port: number;
  // The upstream's certificate, to pass to clients as `ca`
  readonly ca: string;
  readonly requests: readonly RecordedRequest[];
  // TLS connections accepted so far
  readonly connections: number;
  url(hostname: string, path?: string): string;
  /** Replaces the handler. The default answers 200 "ok". */
  handle(handler: UpstreamHandler): void;
  close(): Promise<void>;
}

export interface FakeUpstreamOptions {
  // Names and addresses the certificate covers. Point them at 127.0.0.1 with a fake resolver.
  readonly hosts: readonly string[];
}

const defaultHandler: UpstreamHandler = (_request, response) => {
  response.end('ok');
};

/** A scripted HTTPS server on 127.0.0.1 that records every request it receives. */
export const startFakeUpstream = async ({ hosts }: FakeUpstreamOptions): Promise<FakeUpstream> => {
  const { cert, key } = createTestCertificate({ hosts });
  const requests: RecordedRequest[] = [];
  let handler = defaultHandler;
  let connections = 0;

  const server = createServer({ cert, key }, (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', () => undefined);
    request.on('end', () => {
      const recorded: RecordedRequest = {
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks),
        servername: (request.socket as TLSSocket).servername || undefined,
      };
      requests.push(recorded);
      void Promise.resolve(handler(recorded, response)).catch(() => response.destroy());
    });
  });
  server.on('secureConnection', () => {
    connections += 1;
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    ca: cert,
    requests,
    get connections() {
      return connections;
    },
    url: (hostname, path = '/') => `https://${hostname}:${port}${path}`,
    handle: next => {
      handler = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
};
