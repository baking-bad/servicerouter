import { TextDecoder } from 'node:util';

import {
  isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, visit,
  type Document, type DocumentOptions, type ErrorCode, type ParseOptions, type SchemaOptions,
} from 'yaml';

import { ServiceRouterError } from './errors.js';
import { isRecord } from './object.js';
import { findUnsafeValue, mergeKey, unsafeKeys, type ValuePath } from './safeValue.js';

export const maxDocumentBytes = 1024 * 1024;
export const maxAliasCount = 50;
// The parser's own guard against exponential alias expansion. It weighs each alias by what it
// expands to, so it stops "billion laughs" documents that stay under maxAliasCount.
const maxAliasExpansion = 100;

export interface SourcePosition {
  // 1-based
  readonly line: number;
  readonly column: number;
}

export interface LocateOptions {
  // Point at the key instead of its value, for example for an unknown field
  readonly key?: boolean;
}

export interface StrictYamlDocument {
  readonly value: Record<string, unknown>;
  readonly source: string | undefined;
  /** The position of the node at `path`, or of its nearest ancestor that exists. */
  locate(path: ValuePath, options?: LocateOptions): SourcePosition | undefined;
  /** Whether the document contains a node at `path`. */
  has(path: ValuePath): boolean;
}

export interface StrictYamlOptions {
  // A name for messages, such as a file path
  readonly source?: string;
  readonly maxBytes?: number;
}

export interface DocumentErrorDetails {
  readonly source?: string;
  readonly path?: ValuePath;
  readonly position?: SourcePosition;
}

export class DocumentError extends ServiceRouterError {
  readonly code = 'invalid_document';
  // What is wrong, without the location
  readonly reason: string;
  readonly source: string | undefined;
  readonly path: ValuePath | undefined;
  readonly line: number | undefined;
  readonly column: number | undefined;

  constructor(reason: string, { source, path, position }: DocumentErrorDetails = {}) {
    const location = position ? ` at line ${position.line}, column ${position.column}` : '';
    super(`${source ?? 'The document'} is not a valid config document${location}: ${reason}`);

    this.reason = reason;
    this.source = source;
    this.path = path;
    this.line = position?.line;
    this.column = position?.column;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      line: this.line,
      column: this.column,
    };
  }
}

const parseOptions: ParseOptions & DocumentOptions & SchemaOptions = {
  version: '1.2',
  schema: 'core',
  strict: true,
  stringKeys: true,
  uniqueKeys: true,
  customTags: [],
  merge: false,
  resolveKnownTags: false,
  prettyErrors: false,
};

// The parser's own messages can quote the source. These never do, so an error can't leak a value.
const parseErrorMessages: Partial<Record<ErrorCode, string>> = {
  DUPLICATE_KEY: 'duplicate key',
  MULTIPLE_DOCS: 'only one document is allowed',
  TAG_RESOLVE_FAILED: 'custom tags are not allowed',
  MULTIPLE_TAGS: 'custom tags are not allowed',
  BAD_COLLECTION_TYPE: 'custom tags are not allowed',
  NON_STRING_KEY: 'keys must be strings',
  BAD_ALIAS: 'an alias refers to an unknown anchor',
  ALIAS_PROPS: 'an alias can\'t have a tag or an anchor',
  TAB_AS_INDENT: 'tabs are not allowed as indentation',
  KEY_OVER_1024_CHARS: 'a key is longer than 1024 characters',
};

// C0 controls other than tab, LF and CR, plus DEL. YAML 1.2 forbids them; Postgres text rejects NUL.
const forbiddenCharacter = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

const decode = (input: string | Uint8Array, source: string | undefined, maxBytes: number): string => {
  const size = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
  if (size > maxBytes)
    throw new DocumentError(`it exceeds the ${maxBytes}-byte size limit`, { source });

  if (typeof input === 'string') {
    if (loneSurrogate.test(input))
      throw new DocumentError('it is not valid Unicode text', { source });

    return input;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input);
  }
  catch {
    throw new DocumentError('it is not valid UTF-8', { source });
  }
};

type FoundNode = { readonly offset: number | undefined; readonly exact: boolean };

const rangeStart = (node: unknown): number | undefined => {
  const range = (node as { range?: readonly number[] | null } | null)?.range;

  return range?.[0];
};

const findNode = (document: Document, path: ValuePath, key: boolean): FoundNode => {
  let node: unknown = document.contents;
  let keyNode: unknown;

  for (const segment of path) {
    if (isAlias(node))
      node = node.resolve(document);

    let next: unknown;
    if (isMap(node)) {
      const pair = node.items.find(item => isScalar(item.key) && String(item.key.value) === String(segment));
      if (pair) {
        keyNode = pair.key;
        next = pair.value ?? pair.key;
      }
    }
    else if (isSeq(node)) {
      const index = typeof segment === 'number' ? segment : Number(segment);
      next = Number.isInteger(index) ? node.items[index] : undefined;
      keyNode = undefined;
    }

    if (next === undefined || next === null)
      return { offset: rangeStart(node), exact: false };

    node = next;
  }

  return { offset: rangeStart(key && keyNode ? keyNode : node), exact: true };
};

/**
 * Parses a YAML or JSON config document the strict way (CK-8): YAML 1.2 core schema, unique keys, no
 * custom tags or merge keys, at most 50 aliases, a 1 MiB limit, fatal UTF-8 decoding, nesting of at
 * most 64 levels, no cycles, and no prototype-polluting keys. The root must be a mapping.
 *
 * Throws a DocumentError with the position of the first problem. Messages never quote the source.
 */
export const parseStrictYaml = (input: string | Uint8Array, options: StrictYamlOptions = {}): StrictYamlDocument => {
  const { source, maxBytes = maxDocumentBytes } = options;
  const text = decode(input, source, maxBytes);
  const lineCounter = new LineCounter();
  const position = (offset: number | undefined): SourcePosition | undefined => {
    if (offset === undefined)
      return undefined;

    const { line, col } = lineCounter.linePos(offset);

    return { line, column: col };
  };

  const forbidden = forbiddenCharacter.exec(text);
  if (forbidden) {
    const before = text.slice(0, forbidden.index);
    const line = before.split('\n').length;
    const column = forbidden.index - before.lastIndexOf('\n');
    throw new DocumentError('it contains a control character', { source, position: { line, column } });
  }

  let document: Document;
  try {
    document = parseDocument(text, { ...parseOptions, lineCounter });
  }
  catch {
    // The parser recurses per nesting level; a pathological document can exhaust the stack
    throw new DocumentError('it could not be parsed', { source });
  }

  const issue = document.errors[0] ?? document.warnings[0];
  if (issue)
    throw new DocumentError(parseErrorMessages[issue.code] ?? 'invalid YAML or JSON syntax', { source, position: position(issue.pos[0]) });
  if (document.contents === null)
    throw new DocumentError('it is empty', { source });
  if (!isMap(document.contents))
    throw new DocumentError('the root must be a mapping', { source, position: position(rangeStart(document.contents)) });

  let aliasCount = 0;
  let structureError: DocumentError | undefined;
  visit(document, {
    Pair: (_key, pair) => {
      const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
      const reason = key !== undefined && unsafeKeys.includes(key)
        ? `the key "${key}" is not allowed`
        : key === mergeKey ? 'merge keys are not supported' : undefined;
      if (!reason)
        return undefined;

      structureError = new DocumentError(reason, { source, position: position(rangeStart(pair.key)) });

      return visit.BREAK;
    },
    Alias: (_key, alias) => {
      aliasCount += 1;
      const reason = aliasCount > maxAliasCount
        ? `it uses more than ${maxAliasCount} aliases`
        : alias.resolve(document) === undefined ? 'an alias refers to an unknown anchor' : undefined;
      if (!reason)
        return undefined;

      structureError = new DocumentError(reason, { source, position: position(rangeStart(alias)) });

      return visit.BREAK;
    },
  });
  if (structureError)
    throw structureError;

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: maxAliasExpansion });
  }
  catch {
    throw new DocumentError('its aliases expand too far', { source });
  }

  const locate = (path: ValuePath, { key = false }: LocateOptions = {}): SourcePosition | undefined =>
    position(findNode(document, path, key).offset);

  const unsafe = findUnsafeValue(value);
  if (unsafe)
    throw new DocumentError(unsafe.message, { source, path: unsafe.path, position: locate(unsafe.path, { key: unsafe.key }) });
  if (!isRecord(value))
    throw new DocumentError('the root must be a mapping', { source });

  return {
    value,
    source,
    locate,
    has: path => findNode(document, path, false).exact,
  };
};
