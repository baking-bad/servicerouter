import { OutboundHttpError, outboundFields, type OutboundHttp } from '@servicerouter/common';

import { ownershipFileLimits, ownershipFileUrl, parseOwnershipFile, type OwnershipFile } from './file.js';
import type { HostProblem } from './state.js';

export type FetchOwnershipFileResult =
  | { readonly ok: true; readonly file: OwnershipFile }
  // `reason` names the host and what went wrong, never anything from the response. `outbound` is the
  // call for the log: host, method, path, status or error code, and duration (L-4).
  | {
    readonly ok: false;
    readonly problem: Exclude<HostProblem, 'token_missing'>;
    readonly reason: string;
    readonly outbound?: Readonly<Record<string, string | number>>;
  };

export type FetchOwnershipFile = (host: string, signal?: AbortSignal) => Promise<FetchOwnershipFileResult>;

export interface OwnershipFileFetcherOptions {
  // Outbound HTTP with the production address policy and our own hosts refused (OH-1, OH-5)
  readonly http: Pick<OutboundHttp, 'request'>;
  // The file's URL for a host. Default: `https://<host>/.well-known/servicerouter.json`. Tests point it
  // at a fake upstream's port.
  readonly fileUrl?: (host: string) => string;
}

const firstLower = (text: string): string => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/**
 * Fetches and parses a host's ownership file (OV-2, OV-8): through Outbound HTTP, with same-host
 * redirects, the private-IP block, a 64 KiB limit, and short timeouts. Any failure is a result, never
 * a throw, so one broken host doesn't stop the others' checks.
 */
export const createOwnershipFileFetcher = ({ http, fileUrl = ownershipFileUrl }: OwnershipFileFetcherOptions): FetchOwnershipFile =>
  async (host, signal) => {
    const url = fileUrl(host);
    const started = performance.now();
    const outbound = (call: { readonly status?: number; readonly error?: unknown }) =>
      outboundFields({ url, method: 'GET', ...call, durationMs: performance.now() - started });
    let bytes: Buffer;
    try {
      const response = await http.request({
        url,
        redirect: 'sameHost',
        headers: { accept: 'application/json' },
        totalTimeoutMs: ownershipFileLimits.totalTimeoutMs,
        maxResponseBytes: ownershipFileLimits.maxBytes,
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status < 200 || response.status > 299) {
        response.dispose();

        return response.status === 404 || response.status === 410
          ? { ok: false, problem: 'file_not_found', reason: `${host} has no ownership file`, outbound: outbound({ status: response.status }) }
          : { ok: false, problem: 'fetch_failed', reason: `${host} answered with status ${response.status}`, outbound: outbound({ status: response.status }) };
      }
      bytes = await response.bytes();
    }
    catch (error) {
      return {
        ok: false,
        problem: 'fetch_failed',
        reason: error instanceof OutboundHttpError ? firstLower(error.message) : `${host} can't be reached`,
        outbound: outbound({ error }),
      };
    }

    const parsed = parseOwnershipFile(bytes);

    return parsed.ok
      ? { ok: true, file: parsed.file }
      : { ok: false, problem: 'invalid_file', reason: `${host}'s ownership file is invalid: ${parsed.reason}` };
  };
