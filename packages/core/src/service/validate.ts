import {
  deepFreeze, DocumentError, findUnsafeValue, isRecord, parseStrictYaml, type StrictYamlDocument, type ValidationIssue,
} from '@servicerouter/common';

import { createDocumentLocator, toIssues, toPointer, type IssueDraft, type IssueLocator } from '../validation/issues.js';
import { toSchemaDrafts } from '../validation/schema.js';
import { checkServiceConfig, type ServiceConfigContext } from './checks.js';
import { compileRuntimeDrafts } from './compile.js';
import type { ServiceConfigDocument } from './document.js';
import { findReservedFields } from './reserved.js';
import type { ServiceRuntime, ServiceState } from './runtime.js';
import { validateConfigShape } from './shape.js';

/** YAML or JSON text, its bytes, or a JSON object, such as the `config` of a submit envelope (SR-12). */
export type ServiceConfigSource = string | Uint8Array | Readonly<Record<string, unknown>>;

export interface ParsedServiceConfig {
  readonly config: ServiceConfigDocument;
  // Present when the source was text: maps issues to lines and columns
  readonly document: StrictYamlDocument | undefined;
}

export type ParseServiceConfigResult =
  | { readonly ok: true; readonly parsed: ParsedServiceConfig }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

export type ServiceConfigResult =
  | { readonly ok: true; readonly config: ServiceConfigDocument; readonly warnings: readonly ValidationIssue[] }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[]; readonly warnings: readonly ValidationIssue[] };

const failure = (errors: readonly ValidationIssue[]): ParseServiceConfigResult => ({ ok: false, errors });

const fromDocumentError = (error: DocumentError): ValidationIssue => ({
  path: error.path ? toPointer(error.path) : '',
  message: error.reason,
  ...(error.line === undefined ? {} : { line: error.line, column: error.column ?? 1 }),
});

export const locatorFor = (document: StrictYamlDocument | undefined): IssueLocator | undefined =>
  document ? createDocumentLocator([document]) : undefined;

/**
 * Pass 1 of SR-2: strict loading (SR-1), reserved fields (SR-9), and the JSON Schema. Reports every
 * schema problem at once, each with its path and, for text, its line and column. Never throws on bad
 * input.
 */
export const parseServiceConfig = (source: ServiceConfigSource): ParseServiceConfigResult => {
  let document: StrictYamlDocument | undefined;
  let value: Record<string, unknown>;
  if (typeof source === 'string' || source instanceof Uint8Array) {
    try {
      document = parseStrictYaml(source);
    }
    catch (error) {
      if (error instanceof DocumentError)
        return failure([fromDocumentError(error)]);
      throw error;
    }
    value = document.value;
  }
  else {
    const unsafe = findUnsafeValue(source);
    if (unsafe)
      return failure(toIssues([{ path: unsafe.path, message: unsafe.message, key: unsafe.key }]));
    if (!isRecord(source))
      return failure([{ path: '', message: 'the config must be an object' }]);
    // A private copy: the result is frozen, and the caller's object must stay theirs
    value = structuredClone(source) as Record<string, unknown>;
  }

  const reserved = findReservedFields(value);
  const reservedPointers = new Set(reserved.map(draft => toPointer(draft.path)));
  const schemaDrafts: readonly IssueDraft[] = validateConfigShape(value)
    ? []
    : toSchemaDrafts(validateConfigShape.errors ?? [])
      .filter(draft => !reservedPointers.has(toPointer(draft.path)));
  const drafts = [...reserved, ...schemaDrafts];
  if (drafts.length > 0)
    return failure(toIssues(drafts, locatorFor(document)));

  return { ok: true, parsed: { config: deepFreeze(value as unknown as ServiceConfigDocument), document } };
};

/** Pass 2 of SR-2 on a parsed config. Errors and warnings carry positions when the source was text. */
export const checkParsedServiceConfig = (parsed: ParsedServiceConfig, context: ServiceConfigContext): ServiceConfigResult => {
  const locator = locatorFor(parsed.document);
  const { errors, warnings } = checkServiceConfig(parsed.config, context);
  const warningIssues = toIssues(warnings, locator);

  return errors.length > 0
    ? { ok: false, errors: toIssues(errors, locator), warnings: warningIssues }
    : { ok: true, config: parsed.config, warnings: warningIssues };
};

/**
 * Validates a submitted service config: strict loading, schema, and semantic checks (SR-1, SR-2).
 * Returns every problem of the first failing pass instead of throwing. Fetch the documents named by
 * `getOpenApiLinks` first and pass them in the context.
 */
export const validateServiceConfig = (source: ServiceConfigSource, context: ServiceConfigContext): ServiceConfigResult => {
  const parsed = parseServiceConfig(source);

  return parsed.ok
    ? checkParsedServiceConfig(parsed.parsed, context)
    : { ok: false, errors: parsed.errors, warnings: [] };
};

export interface ServiceRuntimeContext extends ServiceConfigContext {
  readonly revision: number;
  readonly state: ServiceState;
}

export type CompiledServiceConfigResult =
  | {
    readonly ok: true;
    readonly config: ServiceConfigDocument;
    readonly runtime: ServiceRuntime;
    readonly warnings: readonly ValidationIssue[];
  }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[]; readonly warnings: readonly ValidationIssue[] };

/**
 * All three passes of SR-2: schema, semantic checks, and compiling (SR-5). Returns every problem of
 * the first failing pass, each with its path and, for text, its line and column. The runtime takes
 * its service ID from the config.
 */
export const validateAndCompileServiceConfig = (source: ServiceConfigSource, context: ServiceRuntimeContext): CompiledServiceConfigResult => {
  const parsed = parseServiceConfig(source);
  if (!parsed.ok)
    return { ok: false, errors: parsed.errors, warnings: [] };

  const checked = checkParsedServiceConfig(parsed.parsed, context);
  if (!checked.ok)
    return checked;

  const compiled = compileRuntimeDrafts({
    serviceId: checked.config.service.id,
    revision: context.revision,
    state: context.state,
    config: checked.config,
    openapiDocuments: context.openapiDocuments ?? new Map(),
    platform: context.platform,
  });

  return compiled.ok
    ? { ok: true, config: checked.config, runtime: compiled.runtime, warnings: checked.warnings }
    : { ok: false, errors: toIssues(compiled.errors, locatorFor(parsed.parsed.document)), warnings: checked.warnings };
};
