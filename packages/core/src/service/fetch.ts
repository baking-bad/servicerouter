import {
  DocumentError, OutboundHttpError, parseStrictYaml, type OutboundHttp, type OutboundResponse, type ValidationIssue,
} from '@servicerouter/common';

import { toIssues, type IssueDraft } from '../validation/issues.js';
import { getOpenApiLinks } from './checks.js';
import { locatorFor, type ParsedServiceConfig } from './validate.js';

/**
 * Limits for fetching a seller's OpenAPI document (S2-D2). The size and total time apply per request.
 * The connect timeout belongs to the OutboundHttp the caller builds: pass `connectTimeoutMs` from here.
 */
export const openApiFetchLimits = {
  maxBytes: 5 * 1024 * 1024,
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 15_000,
} as const;

export interface FetchOpenApiDocumentsOptions {
  readonly http: Pick<OutboundHttp, 'request'>;
  readonly signal?: AbortSignal;
}

export type FetchOpenApiDocumentsResult =
  | { readonly ok: true; readonly documents: ReadonlyMap<string, unknown> }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

type FetchedDocument =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

// Outbound HTTP messages name the host and the limit, never the URL or anything from the response
const describeFailure = (error: unknown): FetchedDocument => {
  if (!(error instanceof OutboundHttpError))
    throw error;

  return { ok: false, message: `the linked OpenAPI document can't be fetched: ${error.message.charAt(0).toLowerCase()}${error.message.slice(1)}` };
};

const fetchDocument = async (link: string, { http, signal }: FetchOpenApiDocumentsOptions): Promise<FetchedDocument> => {
  let response: OutboundResponse;
  let bytes: Buffer;
  try {
    response = await http.request({
      url: link,
      redirect: 'sameHost',
      headers: { accept: 'application/json, application/yaml;q=0.9, */*;q=0.1' },
      totalTimeoutMs: openApiFetchLimits.totalTimeoutMs,
      maxResponseBytes: openApiFetchLimits.maxBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status < 200 || response.status > 299) {
      response.dispose();
      return { ok: false, message: `the linked OpenAPI document can't be fetched: ${response.url.hostname} answered with status ${response.status}` };
    }
    bytes = await response.bytes();
  }
  catch (error) {
    return describeFailure(error);
  }

  try {
    return { ok: true, value: parseStrictYaml(bytes, { maxBytes: openApiFetchLimits.maxBytes }).value };
  }
  catch (error) {
    if (!(error instanceof DocumentError))
      throw error;

    // The reason is one of the loader's fixed messages; it never quotes the document
    const position = error.line === undefined ? '' : ` at line ${error.line}, column ${error.column ?? 1} of the document`;

    return { ok: false, message: `the linked OpenAPI document doesn't parse as JSON or YAML: ${error.reason}${position}` };
  }
};

/**
 * Fetches every `upstreams[].openapi` link of a parsed config at submit time (SR-3): concurrently,
 * through Outbound HTTP, with same-host redirects and the S2-D2 limits, parsed with the strict loader
 * (CK-8). Returns the documents keyed by link, for `ServiceConfigContext.openapiDocuments`, or an
 * issue at each failing link. No issue contains anything from a response. Whether a document is valid
 * OpenAPI is for `checkServiceConfig` to say.
 */
export const fetchOpenApiDocuments = async (parsed: ParsedServiceConfig, options: FetchOpenApiDocumentsOptions): Promise<FetchOpenApiDocumentsResult> => {
  const links = getOpenApiLinks(parsed.config);
  const fetched = new Map(await Promise.all(links.map(async link => [link, await fetchDocument(link, options)] as const)));

  const documents = new Map<string, unknown>();
  const drafts: IssueDraft[] = [];
  for (const [index, upstream] of parsed.config.upstreams.entries()) {
    const result = upstream.openapi === undefined ? undefined : fetched.get(upstream.openapi);
    if (result?.ok)
      documents.set(upstream.openapi!, result.value);
    else if (result)
      drafts.push({ path: ['upstreams', index, 'openapi'], message: result.message });
  }

  return drafts.length > 0
    ? { ok: false, errors: toIssues(drafts, locatorFor(parsed.document)) }
    : { ok: true, documents };
};
