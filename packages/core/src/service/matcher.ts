import type { HttpMethod } from './document.js';
import { normalizePathText, type OperationMatch, type RuntimeOperation } from './runtime.js';

/** One segment of a path template: literal text, or one parameter with optional literal text around it. */
export type TemplateSegment =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'parameter'; readonly name: string; readonly prefix: string; readonly suffix: string };

export type ParseTemplateResult =
  | { readonly ok: true; readonly segments: readonly TemplateSegment[] }
  | { readonly ok: false; readonly message: string };

const placeholder = /\{([^{}]*)\}/g;

/**
 * Splits a path template into segments, with literal text normalized (`normalizePathText`). A segment
 * holds at most one parameter, and a parameter name appears once.
 */
export const parseTemplate = (template: string): ParseTemplateResult => {
  if (!template.startsWith('/'))
    return { ok: false, message: 'must start with "/"' };

  const segments: TemplateSegment[] = [];
  const names = new Set<string>();
  for (const segment of template.slice(1).split('/')) {
    if (/[{}]/.test(segment.replace(placeholder, '')))
      return { ok: false, message: 'has a "{" or "}" that is not part of a {parameter}' };

    const parameters = [...segment.matchAll(placeholder)];
    const [parameter] = parameters;
    if (!parameter) {
      segments.push({ kind: 'literal', text: normalizePathText(segment) });
      continue;
    }
    if (parameters.length > 1)
      return { ok: false, message: `has ${parameters.length} parameters in one segment. A segment can hold only one` };

    const name = parameter[1]!;
    if (!name)
      return { ok: false, message: 'has a parameter without a name' };
    if (names.has(name))
      return { ok: false, message: `uses the parameter {${name}} twice` };
    names.add(name);
    segments.push({
      kind: 'parameter',
      name,
      prefix: normalizePathText(segment.slice(0, parameter.index)),
      suffix: normalizePathText(segment.slice(parameter.index + parameter[0].length)),
    });
  }

  return { ok: true, segments };
};

interface Terminal {
  readonly operation: RuntimeOperation;
  // The parameter name at each segment, or undefined for a literal segment
  readonly names: readonly (string | undefined)[];
}

interface PatternEdge {
  readonly prefix: string;
  readonly suffix: string;
  readonly node: TrieNode;
}

interface TrieNode {
  readonly literals: Map<string, TrieNode>;
  // Parameters with literal text around them, such as {id}.json. Most literal text first.
  readonly patterns: PatternEdge[];
  parameter: TrieNode | undefined;
  terminal: Terminal | undefined;
}

// Code-unit order, so the result never depends on the locale
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const createNode = (): TrieNode => ({ literals: new Map(), patterns: [], parameter: undefined, terminal: undefined });

const child = (node: TrieNode, segment: TemplateSegment): TrieNode => {
  if (segment.kind === 'literal') {
    const existing = node.literals.get(segment.text);
    if (existing)
      return existing;

    const created = createNode();
    node.literals.set(segment.text, created);

    return created;
  }
  if (!segment.prefix && !segment.suffix)
    return node.parameter ??= createNode();

  const existing = node.patterns.find(edge => edge.prefix === segment.prefix && edge.suffix === segment.suffix);
  if (existing)
    return existing.node;

  const edge: PatternEdge = { prefix: segment.prefix, suffix: segment.suffix, node: createNode() };
  node.patterns.push(edge);
  node.patterns.sort((left, right) => (right.prefix.length + right.suffix.length) - (left.prefix.length + left.suffix.length)
    || compareText(left.prefix, right.prefix) || compareText(left.suffix, right.suffix));

  return edge.node;
};

export interface MatcherBuilder {
  /** Adds an operation. Returns the operation already at the same method and path shape, if any. */
  add(operation: RuntimeOperation, segments: readonly TemplateSegment[]): RuntimeOperation | undefined;
  build(): (method: string, segments: readonly string[]) => OperationMatch | undefined;
}

/** A trie per method, built once at compile time (rule 9). A match walks the trie, not the operations. */
export const createMatcherBuilder = (): MatcherBuilder => {
  const roots = new Map<string, TrieNode>();

  const search = (node: TrieNode, segments: readonly string[], index: number, values: string[]): Terminal | undefined => {
    if (index === segments.length)
      return node.terminal;

    const segment = segments[index]!;
    const literal = node.literals.get(segment);
    const viaLiteral = literal && search(literal, segments, index + 1, values);
    if (viaLiteral)
      return viaLiteral;
    if (!segment)
      return undefined;

    for (const edge of node.patterns) {
      if (segment.length > edge.prefix.length + edge.suffix.length && segment.startsWith(edge.prefix) && segment.endsWith(edge.suffix)) {
        values[index] = segment.slice(edge.prefix.length, segment.length - edge.suffix.length);
        const viaPattern = search(edge.node, segments, index + 1, values);
        if (viaPattern)
          return viaPattern;
      }
    }
    if (!node.parameter)
      return undefined;

    values[index] = segment;

    return search(node.parameter, segments, index + 1, values);
  };

  return {
    add: (operation, segments) => {
      const method: HttpMethod = operation.method;
      let node = roots.get(method);
      if (!node) {
        node = createNode();
        roots.set(method, node);
      }
      for (const segment of segments)
        node = child(node, segment);
      if (node.terminal)
        return node.terminal.operation;

      node.terminal = { operation, names: segments.map(segment => segment.kind === 'parameter' ? segment.name : undefined) };

      return undefined;
    },
    build: () => (method, segments) => {
      const root = roots.get(method.toLowerCase());
      const values: string[] = [];
      const terminal = root && search(root, segments, 0, values);
      if (!terminal)
        return undefined;

      const params = Object.fromEntries(terminal.names.flatMap((name, index) => name === undefined ? [] : [[name, values[index]!]]));

      return { operation: terminal.operation, params };
    },
  };
};
