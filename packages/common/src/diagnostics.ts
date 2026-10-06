import { ServiceRouterError } from './errors.js';
import { OutboundHttpError } from './net/errors.js';

/**
 * What a log line says about an error (L-9): its type, message, code, a few safe fields, and its cause
 * chain, with a stack when the error is unexpected. Never a request or response body, a URL's query, a
 * signed transaction, or a key: errors from viem, the x402 SDKs, and `mppx` are reduced to their safe
 * fields (`shortMessage`, status, reason).
 */
export interface SerializedError {
  readonly type: string;
  readonly message: string;
  readonly code?: string | number;
  readonly status?: number;
  readonly stack?: string;
  readonly cause?: SerializedError;
  readonly errors?: readonly SerializedError[];
  readonly [field: string]: unknown;
}

const maxCauseDepth = 5;
const maxMessageLength = 1_000;
const maxFieldLength = 200;
const maxStackFrames = 20;
const maxAggregated = 3;

// Fields an error may carry that name what failed, never what was sent: hosts, phases, reasons, hashes
const safeFields = [
  'host', 'phase', 'timeoutMs', 'facilitator', 'network', 'path', 'method', 'reason', 'outcome', 'transaction', 'syscall', 'constraint',
  'secretName', 'durationMs', 'attempt',
] as const;

type ErrorLike = Error & Record<string, unknown>;

const oneLine = (text: string, limit: number): string => {
  const line = text.replace(/\s*\n\s*/g, ' ').trim();

  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};

// A URL in a message keeps its origin and path: its query or fragment can carry a key
const withoutQueries = (text: string): string => text.replace(/(\bhttps?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, '$1');

const firstLine = (text: string): string => text.split('\n', 1)[0]!;

// x402's VerifyError and SettleError: the facilitator's reason, never its free-text message
const x402Reason = (error: ErrorLike): string | undefined => {
  if (error.name !== 'VerifyError' && error.name !== 'SettleError')
    return undefined;
  const reason = error['invalidReason'] ?? error['errorReason'];

  return typeof reason === 'string' ? reason : 'unknown reason';
};

/** The message an error may show in a log. */
const safeMessage = (error: ErrorLike): string => {
  // viem and ox: the full message carries the request body, which for a broadcast is a signed transaction
  if (typeof error['shortMessage'] === 'string')
    return oneLine(error['shortMessage'], maxMessageLength);
  const reason = x402Reason(error);
  if (reason !== undefined)
    return oneLine(reason, maxFieldLength);
  // mppx's payment errors: the first line; the rest describes the buyer's own payment
  if (typeof error['toProblemDetails'] === 'function')
    return oneLine(firstLine(error.message), maxFieldLength);
  // JSON.parse quotes the text it failed on
  if (error.name === 'SyntaxError')
    return oneLine(error.message.replace(/"(?:[^"\\]|\\.)*"/g, '"…"'), maxFieldLength);
  if (error instanceof ServiceRouterError)
    return error.message.length > maxMessageLength ? `${error.message.slice(0, maxMessageLength)}…` : error.message;

  return oneLine(withoutQueries(error.message), maxMessageLength);
};

/** The stack's frames under a safe first line: the stack's own first line repeats the full message. */
export const safeStack = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || typeof error.stack !== 'string')
    return undefined;
  const frames = error.stack.split('\n').filter(line => /^\s+at /.test(line)).slice(0, maxStackFrames);
  if (frames.length === 0)
    return undefined;

  return [`${error.name}: ${safeMessage(error as ErrorLike)}`, ...frames].join('\n');
};

const codeOf = (error: ErrorLike): string | number | undefined => {
  const { code } = error;
  if (typeof code === 'number' && Number.isFinite(code))
    return code;

  return typeof code === 'string' && code.length <= 64 ? code : undefined;
};

const statusOf = (error: ErrorLike): number | undefined => {
  const status = error['status'] ?? error['statusCode'];

  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
};

const fieldsOf = (error: ErrorLike): Record<string, string | number | boolean> => {
  // viem's and mppx's other fields hold URLs, request bodies, and payment details
  if (typeof error['shortMessage'] === 'string' || typeof error['toProblemDetails'] === 'function')
    return {};

  const fields: Record<string, string | number | boolean> = {};
  for (const name of safeFields) {
    const value = error[name];
    if (typeof value === 'number' || typeof value === 'boolean')
      fields[name] = value;
    else if (typeof value === 'string' && value !== '')
      fields[name] = oneLine(name === 'path' ? value.split(/[?#]/, 1)[0]! : withoutQueries(value), maxFieldLength);
  }
  if (x402Reason(error) !== undefined)
    fields['reason'] = x402Reason(error)!;

  return fields;
};

// The message with its causes', joined by `: `, as pino's own serializer writes it
const messageWithCauses = (error: ErrorLike): string => {
  const parts = [safeMessage(error)];
  const seen = new Set<unknown>([error]);
  for (let cause = error.cause; cause instanceof Error && !seen.has(cause) && parts.length <= maxCauseDepth; cause = cause.cause) {
    seen.add(cause);
    parts.push(safeMessage(cause as ErrorLike));
  }

  return parts.filter(part => part !== '').join(': ');
};

const serialize = (value: unknown, depth: number, seen: Set<unknown>, top: boolean): SerializedError => {
  if (!(value instanceof Error)) {
    return {
      type: value === null ? 'null' : Array.isArray(value) ? 'Array' : typeof value,
      message: typeof value === 'string' ? oneLine(withoutQueries(value), maxFieldLength) : 'A thrown value that isn\'t an Error',
    };
  }

  seen.add(value);
  const error = value as ErrorLike;
  const code = codeOf(error);
  const status = statusOf(error);
  const cause = error.cause;
  const aggregated = Array.isArray(error['errors']) ? (error['errors'] as unknown[]).slice(0, maxAggregated) : [];
  const nested = depth < maxCauseDepth;
  // A stack only for the unexpected: our coded errors name their cause, their causes are context
  const stack = top && !(error instanceof ServiceRouterError) ? safeStack(error) : undefined;

  return {
    type: error.name || error.constructor.name,
    // The top line reads as the whole story; each cause below keeps its own fields
    message: top ? messageWithCauses(error) : safeMessage(error),
    ...code === undefined ? {} : { code },
    ...status === undefined ? {} : { status },
    ...fieldsOf(error),
    ...stack === undefined ? {} : { stack },
    ...nested && cause !== undefined && !seen.has(cause) ? { cause: serialize(cause, depth + 1, seen, false) } : {},
    ...nested && aggregated.length > 0 ? { errors: aggregated.filter(item => !seen.has(item)).map(item => serialize(item, depth + 1, seen, false)) } : {},
  };
};

/** The logger's serializer for `error` and `err` (L-9). */
export const serializeError = (value: unknown): SerializedError => serialize(value, 0, new Set(), true);

// Transport codes: system errors, undici's, and TLS verification failures
const transportCodePattern = /^(?:E[A-Z0-9_]{2,}|UND_ERR_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z0-9_]+|[A-Z_]*CERT[A-Z_]*|UNABLE_TO_[A-Z_]+)$/;

const chainOf = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  const queue: unknown[] = [error];
  while (queue.length > 0 && chain.length < 12) {
    const next = queue.shift();
    if (!(next instanceof Error) || chain.includes(next))
      continue;
    chain.push(next);
    queue.push(next.cause, ...(Array.isArray((next as ErrorLike)['errors']) ? (next as ErrorLike)['errors'] as unknown[] : []));
  }

  return chain;
};

/**
 * Why an outbound call failed, as a code (L-4): the transport's own (`ECONNREFUSED`, `ETIMEDOUT`, a TLS
 * error), else Outbound HTTP's (`blocked_address` for the address policy, `outbound_timeout`), else
 * `timeout` or `aborted`. Undefined when nothing says.
 */
export const outboundErrorCode = (error: unknown): string | undefined => {
  const chain = chainOf(error);
  const transport = chain.map(item => (item as ErrorLike).code).filter((code): code is string => typeof code === 'string' && transportCodePattern.test(code)).at(-1);
  if (transport !== undefined)
    return transport;
  const outbound = chain.find(item => item instanceof OutboundHttpError && item.code !== 'connection_failed') as OutboundHttpError | undefined;
  if (outbound)
    return outbound.code;
  if (chain.some(item => (item as Error).name === 'TimeoutError'))
    return 'timeout';
  if (chain.some(item => (item as Error).name === 'AbortError'))
    return 'aborted';

  return chain.some(item => item instanceof OutboundHttpError) ? 'connection_failed' : undefined;
};

export interface OutboundCall {
  readonly url: string | URL;
  readonly method?: string;
  // The answer's status, when there was one
  readonly status?: number;
  // The failure, when there was no answer
  readonly error?: unknown;
  readonly durationMs?: number;
  // 1 for the first try, 2 for a retry, such as a routed call's paid retry
  readonly attempt?: number;
}

/** The fields of an outbound call's log line (L-4): host, method, path without its query, status or error code, duration, attempt. */
export const outboundFields = ({ url, method, status, error, durationMs, attempt }: OutboundCall): Record<string, string | number> => {
  let host = 'unknown';
  let path = '';
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    host = parsed.host;
    path = parsed.pathname;
  }
  catch {
    // Not a URL: the host stays unknown
  }
  const code = error === undefined ? undefined : outboundErrorCode(error);

  return {
    host,
    method: (method ?? 'GET').toUpperCase(),
    path,
    ...status === undefined ? {} : { status },
    ...code === undefined ? {} : { code },
    ...durationMs === undefined ? {} : { durationMs: Math.round(durationMs) },
    ...attempt === undefined ? {} : { attempt },
  };
};

// The headers an upstream or a target names its own request with
const upstreamRequestIdHeaders = ['x-request-id', 'request-id', 'x-amzn-requestid', 'x-amz-request-id', 'x-correlation-id', 'cf-ray'];
const upstreamRequestIdPattern = /^[A-Za-z0-9._:/+=-]{1,128}$/;

/** The upstream's or target's own request ID, from its response headers, when it sends one (L-2). */
export const upstreamRequestIdOf = (headers: Readonly<Record<string, string | readonly string[] | undefined>>): string | undefined => {
  for (const name of upstreamRequestIdHeaders) {
    const value = headers[name];
    const first = typeof value === 'string' ? value : value?.[0];
    if (first !== undefined && upstreamRequestIdPattern.test(first))
      return first;
  }

  return undefined;
};

/** Milliseconds since `started`, a `performance.now()` reading, rounded to the millisecond. */
export const elapsedMs = (started: number): number => Math.round(performance.now() - started);
