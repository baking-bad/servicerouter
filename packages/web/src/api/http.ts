import type { ApiErrorBody } from './types';

// The public Platform API over HTTP (WB-2). Errors keep the API's own code and message (PA-3).

export const defaultTimeoutMs = 5_000;

/** A Platform API error, or the API being unreachable (`api_unavailable`). */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' && value !== null && typeof (value as ApiErrorBody).error?.code === 'string';

export interface ApiRequest {
  readonly method?: string;
  readonly path: string;
  readonly body?: unknown;
  // A master key, for the console (WB-8). It goes in Authorization, never in a URL.
  readonly key?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** Calls the Platform API at `apiUrl` and returns the JSON answer, or throws ApiError. */
export const callApi = async <TResult>(apiUrl: string, { method = 'GET', path, body, key, timeoutMs = defaultTimeoutMs, fetch: fetchFn = fetch }: ApiRequest): Promise<TResult> => {
  let response: Response;
  try {
    response = await fetchFn(`${apiUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  catch {
    throw new ApiError(503, 'api_unavailable', 'The Platform API didn\'t answer. Try again in a moment.');
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  }
  catch {
    parsed = undefined;
  }
  if (!response.ok) {
    if (isErrorBody(parsed))
      throw new ApiError(response.status, parsed.error.code, parsed.error.message);
    throw new ApiError(response.status, 'unexpected_answer', `The Platform API answered ${response.status}`);
  }

  return parsed as TResult;
};
