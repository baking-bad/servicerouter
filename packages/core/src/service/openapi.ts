import { isRecord } from '@servicerouter/common';

import type { HttpMethod } from './document.js';
import { httpMethods } from './schema.js';

export interface Operation {
  readonly method: HttpMethod;
  // The OpenAPI path template, such as /forecast/{city}
  readonly path: string;
  readonly operationId: string | undefined;
  // The operation's own, or else the path item's
  readonly summary: string | undefined;
  readonly description: string | undefined;
}

const optionalText = (...values: readonly unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === 'string');

export type OperationsResult =
  | { readonly ok: true; readonly operations: readonly Operation[] }
  | { readonly ok: false; readonly message: string };

const parameterRegExp = /\{([^{}]+)\}/g;

export const pathParameters = (template: string): readonly string[] =>
  [...template.matchAll(parameterRegExp)].map(match => match[1]!);

// Two templates match the same requests when they differ only in parameter names
export const normalizeTemplate = (template: string): string => template.replace(parameterRegExp, '{}');

/** Lists the operations of an OpenAPI `paths` object. */
export const operationsFromPaths = (paths: unknown): OperationsResult => {
  if (!isRecord(paths))
    return { ok: false, message: 'its "paths" must be an object' };

  const operations: Operation[] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (path.startsWith('x-'))
      continue;
    if (!path.startsWith('/'))
      return { ok: false, message: `the path ${JSON.stringify(path)} must start with "/"` };
    if (!isRecord(pathItem))
      return { ok: false, message: `the path ${JSON.stringify(path)} must be an object` };
    // Resolving references would mean fetching more documents
    if ('$ref' in pathItem)
      return { ok: false, message: `the path ${JSON.stringify(path)} uses "$ref", which is not supported` };

    for (const method of httpMethods) {
      const operation = pathItem[method];
      if (operation === undefined)
        continue;
      if (!isRecord(operation))
        return { ok: false, message: `${method.toUpperCase()} ${path} must be an object` };

      const { operationId } = operation;
      if (operationId !== undefined && (typeof operationId !== 'string' || !operationId))
        return { ok: false, message: `the operationId of ${method.toUpperCase()} ${path} must be a non-empty string` };

      operations.push({
        method,
        path,
        operationId,
        summary: optionalText(operation['summary'], pathItem['summary']),
        description: optionalText(operation['description'], pathItem['description']),
      });
    }
  }

  return operations.length > 0
    ? { ok: true, operations }
    : { ok: false, message: 'it has no operations' };
};

/** Lists the operations of a fetched OpenAPI 3.x document. */
export const operationsFromDocument = (document: unknown): OperationsResult => {
  if (!isRecord(document))
    return { ok: false, message: 'it must be an object' };
  if ('swagger' in document)
    return { ok: false, message: 'Swagger 2.0 is not supported; use OpenAPI 3.0 or 3.1' };
  if (typeof document['openapi'] !== 'string' || !document['openapi'].startsWith('3.'))
    return { ok: false, message: 'it must be an OpenAPI 3.0 or 3.1 document' };

  return operationsFromPaths(document['paths']);
};
