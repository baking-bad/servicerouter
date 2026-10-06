import { normalizePathText } from '@servicerouter/core';

import { InvalidPathError } from '../errors.js';

/** A request to `/service/<service-id>/<path>`, taken apart from the raw request target. */
export interface ServicePath {
  // Normalized: an encoded unreserved character in the ID counts as the character
  readonly serviceId: string;
  // The path after the service ID, split on `/` after its leading one, each normalized with
  // `normalizePathText` (SR-5). `/service/<id>` and `/service/<id>/` are both the root, `['']`.
  readonly segments: readonly string[];
  // The query as received, without the `?`. Empty without one.
  readonly query: string;
}

const dotSegments = new Set(['.', '..']);
// After normalizePathText, an encoded `/` or `\` is always %2F or %5C
const encodedSeparator = /%2F|%5C/;

// A segment that is a dot segment, or holds one between encoded separators that an upstream may decode
const isDotSegment = (segment: string): boolean =>
  dotSegments.has(segment) || segment.split(encodedSeparator).some(piece => dotSegments.has(piece));

/**
 * Splits a raw request target (`request.raw.url`) that starts with `/service/`. Throws InvalidPathError
 * for a `.` or `..` segment, raw or encoded, or one an encoded slash would create, before anything is
 * matched: `targetPath` would otherwise carry it to the upstream, outside the matched template and even
 * outside the base URL's prefix.
 */
export const parseServicePath = (target: string): ServicePath => {
  const queryStart = target.indexOf('?');
  const path = queryStart === -1 ? target : target.slice(0, queryStart);
  const query = queryStart === -1 ? '' : target.slice(queryStart + 1);
  // ['', 'service', '<id>', ...rest]
  const [, , rawId = '', ...rest] = path.split('/');
  const serviceId = normalizePathText(rawId);
  const segments = (rest.length === 0 ? [''] : rest).map(normalizePathText);
  if (isDotSegment(serviceId) || segments.some(isDotSegment))
    throw new InvalidPathError();

  return { serviceId, segments, query };
};
