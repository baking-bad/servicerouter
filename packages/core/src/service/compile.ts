import {
  deepFreeze, getSafeErrorMessage, isRecord, isServiceId, parseUsd, type MicroUsd, type ServiceId, type ValidationIssue, type ValuePath,
} from '@servicerouter/common';

import type { PlatformConfig } from '../platform/config.js';
import { toIssues, type IssueDraft } from '../validation/issues.js';
import { toSchemaDrafts } from '../validation/schema.js';
import type { CredentialDocument, PaymentDocument, RouteDocument, ServiceConfigDocument, UpstreamDocument } from './document.js';
import { bazaarMetadata, inlineLocalReferences, operationObject, type BazaarMetadata } from './discovery.js';
import { createMatcherBuilder, parseTemplate } from './matcher.js';
import { operationsFromDocument, operationsFromPaths, pathParameters, type Operation, type OperationsResult } from './openapi.js';
import {
  normalizePathText, type CredentialApplication, type CredentialReference, type RuntimeOperation, type RuntimeUpstream, type ServiceRuntime,
  type ServiceState,
} from './runtime.js';
import { validateConfigShape } from './shape.js';

export interface CompileServiceRuntimeInput {
  readonly serviceId: ServiceId;
  readonly revision: number;
  readonly state: ServiceState;
  // A config that passed passes 1 and 2 of SR-2
  readonly config: ServiceConfigDocument;
  // The fetched OpenAPI documents, keyed by link (SR-3)
  readonly openapiDocuments: ReadonlyMap<string, unknown>;
  // The pay URL, for the operations' discovery metadata (AD-3)
  readonly platform: PlatformConfig;
}

export type CompileServiceRuntimeResult =
  | { readonly ok: true; readonly runtime: ServiceRuntime }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

export type CompileRuntimeDraftsResult =
  | { readonly ok: true; readonly runtime: ServiceRuntime }
  | { readonly ok: false; readonly errors: readonly IssueDraft[] };

interface UpstreamEntry {
  readonly index: number;
  readonly upstream: RuntimeUpstream;
  readonly operations: readonly Operation[];
  readonly credentials: readonly CredentialReference[];
  // The seller's `paths`, and the document that local references point into (none for inline paths)
  readonly source: { readonly paths: unknown; readonly document: unknown };
}

const serviceStates: readonly ServiceState[] = ['pending', 'live', 'suspended'];

const quote = (value: string): string => JSON.stringify(value);
const describeOperation = (operation: Operation): string => `${operation.method.toUpperCase()} ${operation.path}`;

const toRuntimeUpstream = (upstream: UpstreamDocument): RuntimeUpstream | undefined => {
  try {
    const url = new URL(upstream.baseUrl);
    const pathPrefix = url.pathname.replace(/\/+$/, '');

    return { name: upstream.name, baseUrl: `${url.origin}${pathPrefix}`, origin: url.origin, pathPrefix };
  }
  catch {
    return undefined;
  }
};

const toApplication = (credential: CredentialDocument): CredentialApplication =>
  credential.type === 'http'
    ? { type: credential.scheme }
    : { type: 'apiKey', in: credential.in, name: credential.name };

// Literal text normalized like the matcher's; {parameters} kept as they are
const encodeTarget = (template: string): string =>
  template.split(/(\{[^{}]+\})/).map((part, index) => index % 2 === 1 ? part : normalizePathText(part)).join('');

/**
 * Compiles a validated config into a deeply frozen runtime, with issues as drafts so a caller can add
 * source positions. Pure: no I/O, no secret values, no clock. Collects every problem; never throws on
 * bad input.
 */
export const compileRuntimeDrafts = (input: CompileServiceRuntimeInput): CompileRuntimeDraftsResult => {
  const { config, openapiDocuments } = input;
  // The config's shape is what the rest relies on, so check it again rather than throw on a bad one
  if (!validateConfigShape(config))
    return { ok: false, errors: toSchemaDrafts(validateConfigShape.errors ?? []) };

  const errors: IssueDraft[] = [];
  const error = (path: ValuePath, message: string, key = false) => errors.push({ path, message, key });
  const price = (path: ValuePath, amount: string): MicroUsd | undefined => {
    try {
      return parseUsd(amount);
    }
    catch (amountError) {
      error(path, getSafeErrorMessage(amountError));
      return undefined;
    }
  };

  if (!isServiceId(input.serviceId))
    error([], 'the service ID is not valid');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1)
    error([], 'the revision must be a positive integer');
  if (!serviceStates.includes(input.state))
    error([], `the state must be one of: ${serviceStates.join(', ')}`);

  // Upstreams: operations and credentials
  const credentials = config.credentials ?? {};
  const upstreams: UpstreamEntry[] = [];
  const upstreamNames = new Map<string, UpstreamEntry>();
  for (const [index, document] of config.upstreams.entries()) {
    const upstream = toRuntimeUpstream(document);
    if (!upstream)
      error(['upstreams', index, 'baseUrl'], 'is not a valid URL');

    let result: OperationsResult;
    let source: UpstreamEntry['source'];
    if (document.paths !== undefined) {
      result = operationsFromPaths(document.paths);
      source = { paths: document.paths, document: undefined };
    }
    else {
      const link = document.openapi ?? '';
      const fetched = openapiDocuments.get(link);
      result = openapiDocuments.has(link)
        ? operationsFromDocument(fetched)
        : { ok: false, message: 'it was not loaded' };
      source = { paths: isRecord(fetched) ? fetched['paths'] : undefined, document: fetched };
    }
    if (!result.ok)
      error(['upstreams', index, document.paths === undefined ? 'openapi' : 'paths'], `can't be compiled: ${result.message}`);

    const references = typeof document.auth === 'string' ? [document.auth] : document.auth ?? [];
    const upstreamCredentials = references.flatMap((name, referenceIndex): CredentialReference[] => {
      const credential = Object.hasOwn(credentials, name) ? credentials[name] : undefined;
      if (credential)
        return [{ credential: name, apply: toApplication(credential), secretName: credential.secret }];

      error(typeof document.auth === 'string' ? ['upstreams', index, 'auth'] : ['upstreams', index, 'auth', referenceIndex], 'is not a credential name');
      return [];
    });

    const entry: UpstreamEntry = {
      index,
      upstream: upstream ?? { name: document.name, baseUrl: '', origin: '', pathPrefix: '' },
      operations: result.ok ? result.operations : [],
      credentials: upstreamCredentials,
      source,
    };
    upstreams.push(entry);
    if (document.name !== undefined)
      upstreamNames.set(document.name, entry);
  }

  // Route keys (SR-6): the operationId, or <upstream>/<operationId> when upstreams share it
  const operationIdCounts = new Map<string, number>();
  for (const { operations } of upstreams) {
    for (const { operationId } of operations) {
      if (operationId !== undefined)
        operationIdCounts.set(operationId, (operationIdCounts.get(operationId) ?? 0) + 1);
    }
  }
  const routeKeyOf = (entry: UpstreamEntry, operation: Operation): string | undefined => {
    if (operation.operationId === undefined)
      return undefined;
    if (operationIdCounts.get(operation.operationId) === 1)
      return operation.operationId;

    return entry.upstream.name === undefined ? undefined : `${entry.upstream.name}/${operation.operationId}`;
  };

  // Routes: the configuration for each operation. A key splits on the first "/" only.
  const routes = new Map<Operation, { readonly key: string; readonly route: RouteDocument }>();
  for (const [key, route] of Object.entries(config.routes ?? {})) {
    const separator = key.indexOf('/');
    const owner = separator > 0 ? upstreamNames.get(key.slice(0, separator)) : undefined;
    const operationId = owner ? key.slice(separator + 1) : key;
    const matches = (owner ? [owner] : upstreams).flatMap(entry => entry.operations.filter(operation => operation.operationId === operationId));
    const [operation] = matches;
    if (!operation || matches.length > 1) {
      error(['routes', key], matches.length > 1 ? 'matches several operations; use <upstream>/<operationId>' : 'matches no operation', true);
      continue;
    }
    if (routes.has(operation)) {
      error(['routes', key], `configures the same operation as the route ${quote(routes.get(operation)!.key)}`, true);
      continue;
    }
    routes.set(operation, { key, route });
  }

  // Operations and the matcher
  const defaultPrice = price(['payments', 'default', 'amount'], config.payments.default.amount);
  // P-4: listed in the x402 Bazaar unless the seller opts out
  const discoverable = config.service.discoverable ?? true;
  const matcher = createMatcherBuilder();
  const operations: RuntimeOperation[] = [];
  for (const entry of upstreams) {
    const document = config.upstreams[entry.index]!;
    for (const operation of entry.operations) {
      // An inline path's problem points at the path itself; a fetched one's at the link
      const inline = document.paths !== undefined;
      const location: ValuePath = inline ? ['upstreams', entry.index, 'paths', operation.path] : ['upstreams', entry.index, 'openapi'];
      const template = parseTemplate(operation.path);
      if (!template.ok) {
        error(location, `${describeOperation(operation)} can't be compiled: the path ${template.message}`, inline);
        continue;
      }

      const configured = routes.get(operation);
      let operationPrice = defaultPrice;
      let target = operation.path;
      if (configured) {
        const { key, route } = configured;
        let payment: PaymentDocument | undefined;
        if (typeof route.payment === 'string') {
          payment = Object.hasOwn(config.payments, route.payment) ? config.payments[route.payment] : undefined;
          if (!payment)
            error(['routes', key, 'payment'], 'is not a payment name');
        }
        else
          payment = route.payment;
        // Price merge order: payments.default, then the route's payment. Each layer sets only its own fields.
        if (payment?.amount !== undefined) {
          operationPrice = price(typeof route.payment === 'string'
            ? ['payments', route.payment, 'amount']
            : ['routes', key, 'payment', 'amount'], payment.amount);
        }

        if (route.target) {
          const defined = new Set(pathParameters(operation.path));
          const missing = pathParameters(route.target.path).filter(parameter => !defined.has(parameter));
          if (missing.length > 0)
            error(['routes', key, 'target', 'path'], `uses ${missing.map(parameter => `{${parameter}}`).join(', ')}, which ${describeOperation(operation)} doesn't define`);
          target = route.target.path;
        }
      }
      if (operationPrice === undefined)
        continue;

      const enabled = configured?.route.enabled ?? true;
      // AD-3: what the x402 challenge carries for the Bazaar (PR-7), for paid operations of a discoverable service
      let bazaar: BazaarMetadata | undefined;
      if (discoverable && enabled && operationPrice > 0n) {
        const object = inlineLocalReferences(operationObject(entry.source.paths, operation), entry.source.document);
        bazaar = bazaarMetadata({
          resource: `${input.platform.urls.pay}/service/${input.serviceId}${operation.path}`,
          method: operation.method,
          description: operation.description ?? operation.summary ?? config.service.title,
          object: isRecord(object) ? object : {},
        });
      }
      const compiled: RuntimeOperation = {
        routeKey: routeKeyOf(entry, operation),
        method: operation.method,
        path: operation.path,
        upstream: entry.upstream,
        target: encodeTarget(target),
        price: operationPrice,
        enabled,
        credentials: entry.credentials,
        responses: operation.responses,
        docs: {
          operationId: operation.operationId,
          summary: operation.summary,
          description: operation.description,
          bazaar,
        },
      };
      const existing = matcher.add(compiled, template.segments);
      if (existing)
        error(location, `${describeOperation(operation)} matches the same requests as ${existing.method.toUpperCase()} ${existing.path}`, inline);
      operations.push(compiled);
    }
  }

  if (errors.length > 0)
    return { ok: false, errors };

  const runtime: ServiceRuntime = {
    serviceId: input.serviceId,
    revision: input.revision,
    state: input.state,
    operations,
    match: Object.freeze(matcher.build()),
  };
  // Not enumerable: two runtimes from the same input compare equal by their data
  Object.defineProperty(runtime, 'match', { enumerable: false });

  return { ok: true, runtime: deepFreeze(runtime) };
};

/**
 * Pass 3 of SR-2 (SR-5): compiles a validated config and its OpenAPI documents into the deeply frozen
 * runtime the proxy serves. Pure: the same input gives a deep-equal runtime. Returns every problem
 * instead of throwing.
 */
export const compileServiceRuntime = (input: CompileServiceRuntimeInput): CompileServiceRuntimeResult => {
  const result = compileRuntimeDrafts(input);

  return result.ok ? result : { ok: false, errors: toIssues(result.errors) };
};
