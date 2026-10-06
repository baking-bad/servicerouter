import { describe, expect, it } from 'vitest';

import { findUnsafeValue } from '../src/index.js';

const nest = (depth: number): unknown => {
  let value: unknown = 'leaf';
  for (let level = 0; level < depth; level += 1)
    value = { level: value };

  return value;
};

describe('findUnsafeValue', () => {
  it('accepts plain JSON values', () => {
    expect(findUnsafeValue({ a: [1, 'x', null, true, { b: -0.5 }], c: Object.create(null) })).toBeUndefined();
    expect(findUnsafeValue(nest(65))).toBeUndefined();
  });

  it('rejects nesting deeper than 64 levels, with the path', () => {
    const problem = findUnsafeValue(nest(66));

    expect(problem?.message).toBe('the document is nested deeper than 64 levels');
    expect(problem?.path).toHaveLength(65);
  });

  it('rejects cycles', () => {
    const value: Record<string, unknown> = { a: { b: [] } };
    ((value['a'] as Record<string, unknown>)['b'] as unknown[]).push(value);

    expect(findUnsafeValue(value)).toEqual({ path: ['a', 'b', 0], message: 'the document must not contain cycles', key: false });
  });

  it('accepts the same object reached twice without a cycle', () => {
    const shared = { x: 1 };

    expect(findUnsafeValue({ a: shared, b: [shared, shared] })).toBeUndefined();
  });

  it.each(['__proto__', 'constructor', 'prototype', '<<'])('rejects the key %s', key => {
    const value: unknown = JSON.parse(`{"routes": {"${key}": {}}}`);

    expect(findUnsafeValue(value)).toMatchObject({ path: ['routes', key], key: true });
  });

  it.each([
    ['undefined', { a: undefined }, 'only JSON values are supported'],
    ['a function', { a: () => 1 }, 'only JSON values are supported'],
    ['a date', { a: new Date('2026-10-06T19:50:00+08:00') }, 'only JSON values are supported'],
    ['a map', { a: new Map() }, 'only JSON values are supported'],
    ['a bigint', { a: 1n }, 'only JSON values are supported'],
    ['NaN', { a: Number.NaN }, 'numbers must be finite'],
    ['Infinity', { a: [Infinity] }, 'numbers must be finite'],
    ['a NUL in a string', { a: 'x\0' }, 'strings must not contain NUL characters'],
    ['a NUL in a key', { 'a\0': 1 }, 'keys must not contain NUL characters'],
  ])('rejects %s', (_name, value, message) => {
    expect(findUnsafeValue(value)?.message).toBe(message);
  });
});
