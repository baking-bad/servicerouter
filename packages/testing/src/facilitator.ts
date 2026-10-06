import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FacilitatorPath = '/supported' | '/verify' | '/settle';

export interface FacilitatorRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  // The parsed JSON body, or undefined
  readonly body: unknown;
}

/** A scripted answer. `delayMs` holds it back, such as past the client's timeout. */
export interface FacilitatorAnswer {
  readonly status: number;
  readonly body?: unknown;
  readonly delayMs?: number;
}

export type FacilitatorScript = (request: FacilitatorRequest) => FacilitatorAnswer;

export interface FakeFacilitator {
  readonly url: string;
  // Every request, in order
  readonly requests: readonly FacilitatorRequest[];
  /** Scripts one path until `reset`. */
  handle(path: FacilitatorPath, script: FacilitatorScript): void;
  /** Back to the defaults: everything supported, every payment valid, every settle settled. */
  reset(): void;
  close(): Promise<void>;
}

export interface FakeFacilitatorOptions {
  // CAIP-2 networks it supports with the `exact` scheme
  readonly networks: readonly string[];
  // The Solana fee payer it advertises in `/supported` (base58)
  readonly feePayer?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const field = (value: unknown, ...path: readonly string[]): unknown =>
  path.reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, value);

/** The payer a request's payment names: the EIP-3009 `from` on EVM, or `solana-payer` for a Solana transaction. */
export const payerOf = (body: unknown): string => {
  const from = field(body, 'paymentPayload', 'payload', 'authorization', 'from');

  return typeof from === 'string' ? from : 'solana-payer';
};

/** A fake transaction hash for a network: 32 hex bytes on EVM, 64 hex characters elsewhere. */
export const fakeTransaction = (network: unknown): string =>
  typeof network === 'string' && network.startsWith('eip155:') ? `0x${randomBytes(32).toString('hex')}` : randomBytes(32).toString('hex');

// Answers as the x402 facilitator API does (`@x402/core` 2.28)
export const facilitatorAnswers = {
  valid: (request: FacilitatorRequest): FacilitatorAnswer => ({ status: 200, body: { isValid: true, payer: payerOf(request.body) } }),
  invalid: (reason = 'insufficient_funds') => (): FacilitatorAnswer => ({ status: 200, body: { isValid: false, invalidReason: reason } }),
  settled: (request: FacilitatorRequest): FacilitatorAnswer => {
    const network = field(request.body, 'paymentRequirements', 'network');

    return { status: 200, body: { success: true, transaction: fakeTransaction(network), network, payer: payerOf(request.body) } };
  },
  pending: (transaction: string) => (request: FacilitatorRequest): FacilitatorAnswer => ({
    status: 200,
    body: { success: false, errorReason: 'settlement_pending', transaction, network: field(request.body, 'paymentRequirements', 'network'), payer: payerOf(request.body) },
  }),
  failed: (reason = 'invalid_transaction_state') => (request: FacilitatorRequest): FacilitatorAnswer => ({
    status: 200,
    body: { success: false, errorReason: reason, transaction: '', network: field(request.body, 'paymentRequirements', 'network') },
  }),
  unavailable: (): FacilitatorAnswer => ({ status: 503, body: { error: 'unavailable' } }),
  timeout: (delayMs: number) => (): FacilitatorAnswer => ({ status: 503, delayMs }),
};

/** A scripted x402 facilitator on 127.0.0.1 (PR-5, PR-6) that records every request. */
export const startFakeFacilitator = async ({ networks, feePayer }: FakeFacilitatorOptions): Promise<FakeFacilitator> => {
  const requests: FacilitatorRequest[] = [];
  const defaults: Record<FacilitatorPath, FacilitatorScript> = {
    '/supported': () => ({
      status: 200,
      body: {
        kinds: networks.map(network => ({
          x402Version: 2,
          scheme: 'exact',
          network,
          ...(network.startsWith('solana:') && feePayer ? { extra: { feePayer } } : {}),
        })),
        extensions: [],
        signers: {},
      },
    }),
    '/verify': facilitatorAnswers.valid,
    '/settle': facilitatorAnswers.settled,
  };
  let scripts = { ...defaults };
  const timers = new Set<NodeJS.Timeout>();

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      }
      catch {
        body = undefined;
      }
      const path = (request.url ?? '/').split('?')[0]!;
      const recorded: FacilitatorRequest = { method: request.method ?? '', path, headers: request.headers, body };
      requests.push(recorded);
      const script = scripts[path as FacilitatorPath];
      const answer = script ? script(recorded) : { status: 404, body: { error: 'not found' } };
      const send = () => {
        if (response.destroyed)
          return;
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
      };
      if (answer.delayMs) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          send();
        }, answer.delayMs);
        timers.add(timer);
      }
      else
        send();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    handle: (path, script) => {
      scripts = { ...scripts, [path]: script };
    },
    reset: () => {
      scripts = { ...defaults };
    },
    close: async () => {
      for (const timer of timers)
        clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
};
