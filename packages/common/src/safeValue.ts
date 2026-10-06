export const maxNestingDepth = 64;
export const unsafeKeys: readonly string[] = ['__proto__', 'prototype', 'constructor'];
// With merge keys off, `<<` would silently become an ordinary key
export const mergeKey = '<<';

export type ValuePath = readonly (string | number)[];

export interface UnsafeValue {
  readonly path: ValuePath;
  readonly message: string;
  // The problem is the key at `path`, not its value
  readonly key: boolean;
}

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
};

const checkKey = (key: string): string | undefined => {
  if (unsafeKeys.includes(key))
    return `the key "${key}" is not allowed`;
  if (key === mergeKey)
    return 'merge keys are not supported';
  if (key.includes('\0'))
    return 'keys must not contain NUL characters';

  return undefined;
};

const visit = (value: unknown, path: ValuePath, ancestors: Set<object>): UnsafeValue | undefined => {
  if (typeof value === 'string')
    return value.includes('\0') ? { path, message: 'strings must not contain NUL characters', key: false } : undefined;
  if (typeof value === 'number')
    return Number.isFinite(value) ? undefined : { path, message: 'numbers must be finite', key: false };
  if (value === null || typeof value === 'boolean')
    return undefined;
  if (typeof value !== 'object' || !(Array.isArray(value) || isPlainObject(value)))
    return { path, message: 'only JSON values are supported', key: false };
  if (ancestors.has(value))
    return { path, message: 'the document must not contain cycles', key: false };
  if (ancestors.size > maxNestingDepth)
    return { path, message: `the document is nested deeper than ${maxNestingDepth} levels`, key: false };

  ancestors.add(value);
  try {
    const entries: Iterable<readonly [string | number, unknown]> = Array.isArray(value) ? value.entries() : Object.entries(value);
    for (const [key, nested] of entries) {
      const keyProblem = typeof key === 'string' ? checkKey(key) : undefined;
      if (keyProblem)
        return { path: [...path, key], message: keyProblem, key: true };

      const problem = visit(nested, [...path, key], ancestors);
      if (problem)
        return problem;
    }
  }
  finally {
    ancestors.delete(value);
  }

  return undefined;
};

/**
 * Finds the first part of a value that a config must not contain: a cycle, nesting deeper than 64
 * levels, a prototype-polluting or merge key, a NUL character, a non-finite number, or anything that
 * isn't plain JSON. Applies to parsed YAML and to objects that callers pass in directly.
 */
export const findUnsafeValue = (value: unknown): UnsafeValue | undefined => visit(value, [], new Set());
