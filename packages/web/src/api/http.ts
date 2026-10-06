import type { ApiErrorBody } from './types';

// The public Platform API over HTTP (WB-2). Errors keep the API's own code and message (PA-3).

export const defaultTimeoutMs = 5_000;

/** A read that failed, for the server's log (L-10): no URL query, body, or key. */
export interface ApiFailure {
  // The path without its query
  readonly path: string;
  readonly status: number;
  // The API's error code, or `api_unavailable` and the transport's code, such as `ECONNREFUSED`
  readonly code: string;
  readonly cause?: string;
  readonly durationMs: number;
}

// The transport's error code, from the fetch error's causes, such as ECONNREFUSED or a timeout
const causeOf = (error: unknown): string | undefined => {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth += 1) {
    const { code } = current as { readonly code?: unknown };
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code))
      return code;
    if (current.name === 'TimeoutError')
      return 'timeout';
  }

  return undefined;
};

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
  // Called once when the read fails, before it throws: the server's readers log it (L-10). The
  // console in the browser never passes one.
  readonly onFailure?: (failure: ApiFailure) => void;
}

/** Calls the Platform API at `apiUrl` and returns the JSON answer, or throws ApiError. */
export const callApi = async <TResult>(
  apiUrl: string,
  { method = 'GET', path, body, key, timeoutMs = defaultTimeoutMs, fetch: fetchFn = fetch, onFailure }: ApiRequest,
): Promise<TResult> => {
  const started = performance.now();
  const failed = (status: number, code: string, cause?: string): void => onFailure?.({
    path: path.split('?', 1)[0]!, status, code, ...cause === undefined ? {} : { cause }, durationMs: Math.round(performance.now() - started),
  });
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
  catch (error) {
    failed(503, 'api_unavailable', causeOf(error));
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
    if (isErrorBody(parsed)) {
      failed(response.status, parsed.error.code);
      throw new ApiError(response.status, parsed.error.code, parsed.error.message);
    }
    failed(response.status, 'unexpected_answer');
    throw new ApiError(response.status, 'unexpected_answer', `The Platform API answered ${response.status}`);
  }

  return parsed as TResult;
};
