import { isRecord, ServiceRouterError } from '@servicerouter/common';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';

import type { CdpRequestSigner } from './cdp.js';

/** What a log line says about a facilitator call that failed (L-3, L-4). */
export interface FacilitatorCall {
  readonly network?: string;
  // `/supported`, `/verify`, or `/settle`
  readonly path?: string;
  readonly method?: string;
  // The answer's status, when there was one
  readonly status?: number;
  // The answer's errorReason or invalidReason, when it carried one
  readonly errorReason?: string;
  readonly durationMs?: number;
}

/**
 * The facilitator didn't answer usably: a timeout, a connection failure, or a `5xx`. For a settle the
 * outcome is unknown, so the payment is repeated later rather than treated as failed (PR-12).
 */
export class FacilitatorUnavailableError extends ServiceRouterError {
  readonly code = 'facilitator_unavailable';
  readonly network: string | undefined;
  readonly path: string | undefined;
  readonly method: string | undefined;
  readonly status: number | undefined;
  // The answer's errorReason, else what went wrong: `timeout`, `connection failed`, or the status
  readonly reason: string;
  readonly durationMs: number | undefined;

  constructor(readonly facilitator: string, reason: string, options?: ErrorOptions & FacilitatorCall) {
    super(`The ${facilitator} facilitator is unavailable: ${reason}`, options?.cause === undefined ? undefined : { cause: options.cause });

    this.network = options?.network;
    this.path = options?.path;
    this.method = options?.method;
    this.status = options?.status;
    this.reason = options?.errorReason ?? reason;
    this.durationMs = options?.durationMs === undefined ? undefined : Math.round(options.durationMs);
  }
}

export interface FacilitatorOptions {
  // From platform config, for logs and readiness
  readonly name: string;
  readonly url: string;
  // CDP's bearer token per request, or none (the Cardano facilitator takes none)
  readonly signer: CdpRequestSigner | undefined;
  // `/supported` and `/verify`
  readonly requestTimeoutMs: number;
  // `/settle`: `timeouts.settleMs` from platform config (PR-12)
  readonly settleTimeoutMs: number;
  // Default: the global fetch
  readonly fetch?: typeof fetch;
}

/** One facilitator, as the x402 resource server calls it, plus its name. */
export interface Facilitator extends FacilitatorClient {
  readonly name: string;
}

const body = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  }
  catch {
    return undefined;
  }
};

// 4xx answers that say nothing about the payment: our auth, a timeout, or a rate limit
const notRefusals = new Set([401, 403, 408, 429]);

// Answers that say the facilitator can't decide yet, and to ask again: the Cardano facilitator's chain
// backend is down (CF-6). Not a refusal, so the outcome is unknown, like a 503's
const retryableReasons = new Set(['exact_cardano_facilitator_chain_lookup_failed']);

const retryable = (answer: unknown): boolean =>
  isRecord(answer) && [answer['errorReason'], answer['invalidReason']].some(reason => typeof reason === 'string' && retryableReasons.has(reason));

// The answer's own reason, for the log (L-3)
const reasonOf = (answer: unknown): string | undefined => {
  const reason = isRecord(answer) ? answer['errorReason'] ?? answer['invalidReason'] : undefined;

  return typeof reason === 'string' && reason !== '' ? reason.slice(0, 200) : undefined;
};

const isVerifyResponse = (value: unknown): value is VerifyResponse => isRecord(value) && typeof value['isValid'] === 'boolean';

const isSettleResponse = (value: unknown): value is SettleResponse =>
  isRecord(value) && typeof value['success'] === 'boolean' && typeof (value['transaction'] ?? '') === 'string' && typeof value['network'] === 'string';

const isSupportedResponse = (value: unknown): value is SupportedResponse =>
  isRecord(value) && Array.isArray(value['kinds']) && value['kinds'].every(kind => isRecord(kind) && typeof kind['scheme'] === 'string' && typeof kind['network'] === 'string');

/**
 * A facilitator over HTTP (PR-5, PR-6): `GET /supported`, `POST /verify`, `POST /settle`, with the body
 * the x402 SDK's client sends. A `4xx` that carries a verify or settle answer is that answer. Any other
 * `4xx` on verify or settle refuses the payment, as CDP's `400` for a malformed one does, except `401`,
 * `403`, `408`, and `429`. Those, a timeout, a failed connection, a `5xx`, an answer that isn't one, or
 * one that says to ask again later (the Cardano chain backend is down) throw FacilitatorUnavailableError.
 */
export const createFacilitator = ({
  name, url, signer, requestTimeoutMs, settleTimeoutMs, fetch: send = fetch,
}: FacilitatorOptions): Facilitator => {
  const base = url.replace(/\/+$/, '');

  const call = async <TAnswer>(
    method: 'GET' | 'POST',
    path: string,
    payload: unknown,
    timeoutMs: number,
    accept: (value: unknown) => value is TAnswer,
    // The answer to a request the facilitator refused, such as CDP's 400 for a malformed payload
    refused?: () => TAnswer,
    network?: string,
  ): Promise<TAnswer> => {
    const target = new URL(`${base}${path}`);
    const started = performance.now();
    const failure = (extra: Pick<FacilitatorCall, 'status' | 'errorReason'> = {}): FacilitatorCall => ({
      method, path, ...network === undefined ? {} : { network }, ...extra, durationMs: performance.now() - started,
    });
    let response: Response;
    try {
      response = await send(target, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(signer ? { authorization: `Bearer ${signer(method, target)}` } : {}),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value) }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    catch (error) {
      throw new FacilitatorUnavailableError(name, error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'connection failed', { cause: error, ...failure() });
    }
    const answer = await body(response);
    if (response.status < 500 && accept(answer) && !retryable(answer))
      return answer;
    // A 4xx refuses the payment. Auth, timeout, and rate limit answers are ours to fix, not the buyer's.
    if (refused && response.status >= 400 && response.status < 500 && !notRefusals.has(response.status))
      return refused();

    const errorReason = reasonOf(answer);
    throw new FacilitatorUnavailableError(name, `${path} answered ${response.status}`, failure({ status: response.status, ...errorReason === undefined ? {} : { errorReason } }));
  };

  return {
    name,
    getSupported: () => call('GET', '/supported', undefined, requestTimeoutMs, isSupportedResponse),
    verify: (paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) =>
      call('POST', '/verify', { x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements }, requestTimeoutMs, isVerifyResponse,
        () => ({ isValid: false, invalidReason: 'invalid_payload' }), paymentRequirements.network),
    // Refused before anything was submitted: a failed settlement, not an unknown one
    settle: (paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) =>
      call('POST', '/settle', { x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements }, settleTimeoutMs, isSettleResponse,
        () => ({ success: false, errorReason: 'invalid_payload', transaction: '', network: paymentRequirements.network }), paymentRequirements.network),
  };
};
