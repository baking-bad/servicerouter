import { isIP } from 'node:net';

import { getSafeErrorMessage, parseUsd, type ValuePath } from '@servicerouter/common';

import { isValidAddress } from '../addresses.js';
import { findAsset } from '../platform/builder.js';
import type { PlatformConfig } from '../platform/config.js';
import type { IssueDraft } from '../validation/issues.js';
import type { CredentialDocument, ServiceConfigDocument, UpstreamDocument } from './document.js';
import {
  normalizeTemplate, operationsFromDocument, operationsFromPaths, pathParameters, type Operation, type OperationsResult,
} from './openapi.js';
import { getSecretUses } from './secretUses.js';

export interface ServiceConfigContext {
  readonly platform: PlatformConfig;
  // Parsed OpenAPI documents for upstreams with an `openapi` link, keyed by that link. They are
  // fetched at submit time (SR-3); an upstream whose document is missing fails validation.
  readonly openapiDocuments?: ReadonlyMap<string, unknown>;
  // Secrets already set for the service plus those sent with the submit. When given, credentials
  // whose secret is missing get a warning.
  readonly secretNames?: ReadonlySet<string>;
  // Secrets that stay stored through this submit, by name, with the origin each is sealed for
  // (SC-10): those already stored, minus those the submit sends again or deletes. An upstream that
  // sends one of them to another origin fails validation, naming it.
  readonly storedSecretOrigins?: ReadonlyMap<string, string>;
}

export interface ServiceConfigChecks {
  readonly errors: readonly IssueDraft[];
  readonly warnings: readonly IssueDraft[];
}

interface UpstreamOperations {
  readonly index: number;
  readonly upstream: UpstreamDocument;
  readonly operations: readonly Operation[];
}

// Special-use and private names (RFC 6761, RFC 8375, ICANN's .internal). Never a seller's public API.
const nonPublicSuffixes = ['localhost', 'localdomain', 'local', 'internal', 'home.arpa', 'arpa', 'test', 'invalid', 'example', 'onion'];
// Headers the proxy owns. A credential can't set them.
const reservedHeaders = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer',
  'proxy-authorization', 'proxy-connection', 'x-request-id', 'servicerouter-buyer', 'cookie',
]);

const quote = (value: string): string => JSON.stringify(value);
const list = (values: readonly string[]): string => values.map(quote).join(', ');

const isSubdomainOrSelf = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** Lexical checks only. Outbound HTTP checks the resolved addresses when it connects (OH-1). */
const checkBaseUrl = (baseUrl: string, ownHosts: readonly string[]): string | undefined => {
  const url = new URL(baseUrl);
  if (baseUrl.includes('?'))
    return 'must not have a query';

  const host = url.hostname.replace(/\.$/, '');
  if (host.startsWith('[') || isIP(host) !== 0)
    return 'must use a hostname, not an IP address';
  if (!host.includes('.') || nonPublicSuffixes.some(suffix => isSubdomainOrSelf(host, suffix)))
    return 'must use a public hostname';
  if (ownHosts.some(ownHost => isSubdomainOrSelf(host, ownHost)))
    return 'must not point at the platform';

  return undefined;
};

const describeUpstream = ({ index, upstream }: UpstreamOperations): string =>
  upstream.name === undefined ? `upstreams[${index}]` : `upstream ${quote(upstream.name)}`;

const describeOperation = (operation: Operation): string => `${operation.method.toUpperCase()} ${operation.path}`;

// Where to report a problem with an operation: the inline operation, or the link to its document
const operationPath = ({ index, upstream }: UpstreamOperations, operation: Operation): ValuePath =>
  upstream.paths === undefined
    ? ['upstreams', index, 'openapi']
    : ['upstreams', index, 'paths', operation.path, operation.method];

interface CredentialTarget {
  // Header names compare case-insensitively; query parameters and cookies don't
  readonly id: string;
  readonly description: string;
}

const credentialTarget = (credential: CredentialDocument): CredentialTarget => {
  if (credential.type === 'http')
    return { id: 'header:authorization', description: 'the Authorization header' };
  if (credential.in === 'header')
    return { id: `header:${credential.name.toLowerCase()}`, description: `the ${credential.name} header` };

  return {
    id: `${credential.in}:${credential.name}`,
    description: `the ${credential.name} ${credential.in === 'query' ? 'query parameter' : 'cookie'}`,
  };
};

/**
 * Pass 2 of SR-2: rules that need the whole config, the platform config, and the upstreams'
 * operations. Takes a document that passed the schema. Collects every problem; never throws.
 */
export const checkServiceConfig = (config: ServiceConfigDocument, context: ServiceConfigContext): ServiceConfigChecks => {
  const { platform } = context;
  const errors: IssueDraft[] = [];
  const warnings: IssueDraft[] = [];
  const error = (path: ValuePath, message: string, key = false) => errors.push({ path, message, key });
  const warn = (path: ValuePath, message: string, key = false) => warnings.push({ path, message, key });
  const checkAmount = (path: ValuePath, amount: string | undefined) => {
    if (amount === undefined)
      return;
    try {
      parseUsd(amount);
    }
    catch (amountError) {
      error(path, getSafeErrorMessage(amountError));
    }
  };

  // Service and payouts
  if (!platform.categories.some(category => category.id === config.service.category))
    error(['service', 'category'], `is not a platform category. Categories: ${list(platform.categories.map(category => category.id))}`);

  const payout = config.payouts.default;
  const payoutAsset = platform.payouts.assets.includes(payout.asset) ? findAsset(platform, payout.asset) : undefined;
  if (!payoutAsset)
    error(['payouts', 'default', 'asset'], `is not a payout asset. Payout assets: ${list(platform.payouts.assets)}`);
  else if (!isValidAddress(payoutAsset.network, payout.address))
    error(['payouts', 'default', 'address'], `is not a valid address on ${payoutAsset.network.title}`);

  // Payments
  for (const [name, payment] of Object.entries(config.payments))
    checkAmount(['payments', name, 'amount'], payment.amount);

  // Upstreams and their operations
  const upstreamNames = new Map<string, number>();
  const upstreams: UpstreamOperations[] = [];
  for (const [index, upstream] of config.upstreams.entries()) {
    if (upstream.name !== undefined) {
      if (upstreamNames.has(upstream.name))
        error(['upstreams', index, 'name'], `duplicate upstream name ${quote(upstream.name)}`);
      else
        upstreamNames.set(upstream.name, index);
    }

    const baseUrlProblem = checkBaseUrl(upstream.baseUrl, platform.ownHosts);
    if (baseUrlProblem)
      error(['upstreams', index, 'baseUrl'], baseUrlProblem);

    let result: OperationsResult;
    if (upstream.paths !== undefined) {
      result = operationsFromPaths(upstream.paths);
      if (!result.ok)
        error(['upstreams', index, 'paths'], result.message);
    }
    else {
      const link = upstream.openapi!;
      result = context.openapiDocuments?.has(link)
        ? operationsFromDocument(context.openapiDocuments.get(link))
        : { ok: false, message: 'it was not loaded' };
      if (!result.ok)
        error(['upstreams', index, 'openapi'], `the linked OpenAPI document can't be used: ${result.message}`);
    }

    upstreams.push({ index, upstream, operations: result.ok ? result.operations : [] });
  }

  const routeTargets = new Map<string, { readonly owner: UpstreamOperations; readonly operation: Operation }>();
  for (const owner of upstreams) {
    const operationIds = new Set<string>();
    for (const operation of owner.operations) {
      if (operation.operationId !== undefined) {
        if (operationIds.has(operation.operationId))
          error(operationPath(owner, operation), `duplicate operationId ${quote(operation.operationId)} in ${describeUpstream(owner)}`);
        operationIds.add(operation.operationId);
      }

      // The proxy matches the method and path across every upstream of the service
      const routeKey = `${operation.method} ${normalizeTemplate(operation.path)}`;
      const existing = routeTargets.get(routeKey);
      if (existing)
        error(operationPath(owner, operation), `${describeOperation(operation)} conflicts with ${describeOperation(existing.operation)} in ${describeUpstream(existing.owner)}`);
      else
        routeTargets.set(routeKey, { owner, operation });
    }
  }

  // Routes (SR-6)
  const findOperation = (key: string): { readonly owner: UpstreamOperations; readonly operation: Operation } | string => {
    const separator = key.indexOf('/');
    const prefixIndex = separator > 0 ? upstreamNames.get(key.slice(0, separator)) : undefined;
    if (prefixIndex !== undefined) {
      const owner = upstreams[prefixIndex]!;
      const operationId = key.slice(separator + 1);
      const operation = owner.operations.find(item => item.operationId === operationId);

      return operation ? { owner, operation } : `${describeUpstream(owner)} has no operation with operationId ${quote(operationId)}`;
    }

    const matches = upstreams.flatMap(owner => owner.operations
      .filter(operation => operation.operationId === key)
      .map(operation => ({ owner, operation })));
    if (matches.length === 0)
      return `no upstream has an operation with operationId ${quote(key)}`;
    if (matches.length > 1) {
      return matches.every(match => match.owner.upstream.name !== undefined)
        ? `several upstreams have this operationId; use ${list(matches.map(match => `${match.owner.upstream.name!}/${key}`))}`
        : 'several upstreams have this operationId; name them and use <upstream>/<operationId>';
    }

    return matches[0]!;
  };

  const configuredOperations = new Map<Operation, string>();
  const usedPayments = new Set<string>();
  for (const [key, route] of Object.entries(config.routes ?? {})) {
    const found = findOperation(key);
    if (typeof found === 'string')
      error(['routes', key], found, true);
    else {
      const previousKey = configuredOperations.get(found.operation);
      if (previousKey !== undefined)
        error(['routes', key], `configures the same operation as the route ${quote(previousKey)}`, true);
      configuredOperations.set(found.operation, key);

      if (route.target) {
        const defined = new Set(pathParameters(found.operation.path));
        const missing = pathParameters(route.target.path).filter(parameter => !defined.has(parameter));
        if (missing.length > 0)
          error(['routes', key, 'target', 'path'], `uses ${missing.map(parameter => `{${parameter}}`).join(', ')}, which ${describeOperation(found.operation)} doesn't define`);
      }
    }

    if (typeof route.payment === 'string') {
      usedPayments.add(route.payment);
      if (!Object.hasOwn(config.payments, route.payment))
        error(['routes', key, 'payment'], `is not a payment name. Payments: ${list(Object.keys(config.payments))}`);
    }
    else
      checkAmount(['routes', key, 'payment', 'amount'], route.payment?.amount);
  }
  for (const name of Object.keys(config.payments)) {
    if (name !== 'default' && !usedPayments.has(name))
      warn(['payments', name], 'is not used by any route', true);
  }

  // Credentials
  const credentials = config.credentials ?? {};
  const usedCredentials = new Set<string>();
  for (const [index, upstream] of config.upstreams.entries()) {
    const references = typeof upstream.auth === 'string' ? [upstream.auth] : upstream.auth ?? [];
    const targets = new Map<string, string>();
    for (const [referenceIndex, reference] of references.entries()) {
      const path = typeof upstream.auth === 'string' ? ['upstreams', index, 'auth'] : ['upstreams', index, 'auth', referenceIndex];
      const credential = Object.hasOwn(credentials, reference) ? credentials[reference] : undefined;
      if (!credential) {
        error(path, `is not a credential name. Credentials: ${list(Object.keys(credentials))}`);
        continue;
      }

      usedCredentials.add(reference);
      const target = credentialTarget(credential);
      const owner = targets.get(target.id);
      if (owner !== undefined)
        error(path, `sets ${target.description}, like the credential ${quote(owner)}`);
      else
        targets.set(target.id, reference);
    }
  }
  for (const [name, credential] of Object.entries(credentials)) {
    if (credential.type === 'apiKey' && credential.in === 'header' && reservedHeaders.has(credential.name.toLowerCase()))
      error(['credentials', name, 'name'], `the platform sets ${credential.name}; a credential can't`);
    if (!usedCredentials.has(name))
      warn(['credentials', name], 'is not used by any upstream', true);
    else if (context.secretNames && !context.secretNames.has(credential.secret))
      warn(['credentials', name, 'secret'], `the secret ${quote(credential.secret)} is not set. Send it with the config or set it through the secrets API`);
  }

  // Host binding (SC-10): each secret is sealed for the origin of the upstreams that send it
  const secretUses = getSecretUses(config);
  for (const [secret, uses] of secretUses) {
    const origins = [...new Set(uses.map(use => use.origin))];
    if (origins.length < 2)
      continue;

    for (const use of uses) {
      error(['upstreams', use.upstream, 'auth'], `sends the secret ${quote(secret)} to ${use.origin}, and other upstreams send it to `
        + `${origins.filter(origin => origin !== use.origin).join(', ')}. A secret is bound to one host: give each host its own secret`);
    }
  }
  const stored = context.storedSecretOrigins;
  for (const [index, upstream] of stored ? config.upstreams.entries() : []) {
    const origin = new URL(upstream.baseUrl).origin;
    const moved = [...secretUses]
      .filter(([secret, uses]) => stored!.has(secret) && stored!.get(secret) !== origin && uses.some(use => use.upstream === index))
      .map(([secret]) => secret);
    if (moved.length === 0)
      continue;

    const [noun, pronoun] = moved.length === 1 ? ['the secret', 'it'] : ['the secrets', 'them'];
    const storedFor = [...new Set(moved.map(secret => stored!.get(secret)!))].join(', ');
    error(['upstreams', index, 'baseUrl'], `moves ${noun} ${list(moved)} from ${storedFor} to ${origin}. A secret is bound to its host: `
      + `send ${pronoun} again in this request's secrets`);
  }

  return { errors, warnings };
};

/** The OpenAPI links to fetch before checking a config, without duplicates. */
export const getOpenApiLinks = (config: ServiceConfigDocument): readonly string[] =>
  [...new Set(config.upstreams.flatMap(upstream => upstream.openapi === undefined ? [] : [upstream.openapi]))];
