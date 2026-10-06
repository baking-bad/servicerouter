import { describe, expect, it } from 'vitest';

import { DocumentError, maxDocumentBytes, parseStrictYaml } from '../src/index.js';

const parseError = (input: string | Uint8Array): DocumentError => {
  try {
    parseStrictYaml(input, { source: 'service.yaml' });
  }
  catch (error) {
    if (error instanceof DocumentError)
      return error;
    throw error;
  }
  throw new Error('Expected a DocumentError');
};

describe('parseStrictYaml (CK-8)', () => {
  it('parses YAML and JSON into plain objects', () => {
    expect(parseStrictYaml('a: 1\nb: [x, { c: true }]\n').value).toEqual({ a: 1, b: ['x', { c: true }] });
    expect(parseStrictYaml('{"a": [1, null, "x"]}').value).toEqual({ a: [1, null, 'x'] });
    expect(parseStrictYaml(Buffer.from('a: 1')).value).toEqual({ a: 1 });
  });

  it('uses the YAML 1.2 core schema', () => {
    const { value } = parseStrictYaml('yes: yes\nno: no\non: off\nversion: 1.0\ntext: !!str 12\ndate: 2026-10-06T19:50:00+08:00\nempty:\n');

    expect(value).toEqual({ yes: 'yes', no: 'no', on: 'off', version: 1, text: '12', date: '2026-10-06T19:50:00+08:00', empty: null });
  });

  it('locates values, keys, and the nearest existing ancestor', () => {
    const document = parseStrictYaml('service:\n  id: my-app\n  tags: [a, b]\n');

    expect(document.locate(['service', 'id'])).toEqual({ line: 2, column: 7 });
    expect(document.locate(['service', 'id'], { key: true })).toEqual({ line: 2, column: 3 });
    expect(document.locate(['service', 'tags', 1])).toEqual({ line: 3, column: 13 });
    expect(document.locate(['service', 'missing', 'deeper'])).toEqual({ line: 2, column: 3 });
    expect(document.has(['service', 'tags', 0])).toBe(true);
    expect(document.has(['service', 'tags', 2])).toBe(false);
    expect(document.has(['service', 'missing'])).toBe(false);
  });

  it('locates through aliases at the anchored node', () => {
    const document = parseStrictYaml('base: &base\n  amount: "1"\ncopy: *base\n');

    expect(document.value).toEqual({ base: { amount: '1' }, copy: { amount: '1' } });
    expect(document.locate(['copy', 'amount'])).toEqual({ line: 2, column: 11 });
  });

  it('allows up to 50 aliases', () => {
    const aliases = Array.from({ length: 50 }, (_, index) => `a${index}: *x`).join('\n');

    expect(Object.keys(parseStrictYaml(`x: &x 1\n${aliases}`).value)).toHaveLength(51);
  });

  it('accepts 65 levels of nesting', () => {
    expect(() => parseStrictYaml(`a: ${'['.repeat(64)}${']'.repeat(64)}`)).not.toThrow();
  });

  it.each([
    ['duplicate keys', 'a: 1\na: 2', 'duplicate key', { line: 2, column: 1 }],
    ['several documents', 'a: 1\n---\nb: 2', 'only one document is allowed', { line: 2, column: 1 }],
    ['custom tags', 'a: !secret x', 'custom tags are not allowed', { line: 1, column: 4 }],
    ['tags outside the core schema', 'a: !!binary aGk=', 'custom tags are not allowed', { line: 1, column: 4 }],
    ['merge keys', 'b: &b { x: 1 }\na:\n  <<: *b', 'merge keys are not supported', { line: 3, column: 3 }],
    ['__proto__ keys', 'a:\n  __proto__: { polluted: true }', 'the key "__proto__" is not allowed', { line: 2, column: 3 }],
    ['constructor keys', '{"constructor": 1}', 'the key "constructor" is not allowed', { line: 1, column: 2 }],
    ['prototype keys', 'prototype: 1', 'the key "prototype" is not allowed', { line: 1, column: 1 }],
    ['non-string keys', '? [a, b]\n: c', 'keys must be strings', { line: 1, column: 3 }],
    ['tab indentation', 'a:\n\tb: 1', 'tabs are not allowed as indentation', { line: 2, column: 1 }],
    ['unknown anchors', 'a: *missing', 'an alias refers to an unknown anchor', { line: 1, column: 4 }],
    ['control characters', 'a: 1\nb: x\u0001y', 'it contains a control character', { line: 2, column: 5 }],
    ['raw NUL', 'a: x\u0000', 'it contains a control character', { line: 1, column: 5 }],
    ['escaped NUL', 'a: "x\\0"', 'strings must not contain NUL characters', { line: 1, column: 4 }],
    ['infinite numbers', 'a: .inf', 'numbers must be finite', { line: 1, column: 4 }],
    ['NaN', 'a: [1, .nan]', 'numbers must be finite', { line: 1, column: 8 }],
    ['a recursive alias', 'value: &a { nested: *a }', 'the document must not contain cycles', { line: 1, column: 21 }],
    ['a root list', '- a', 'the root must be a mapping', { line: 1, column: 1 }],
    ['a root scalar', 'text', 'the root must be a mapping', { line: 1, column: 1 }],
  ])('rejects %s with a position', (_name, input, reason, position) => {
    const error = parseError(input);

    expect(error.reason).toBe(reason);
    expect({ line: error.line, column: error.column }).toEqual(position);
    expect(error.code).toBe('invalid_document');
    expect(error.message).toContain('service.yaml');
  });

  it.each([
    ['an empty document', '', 'it is empty'],
    ['only comments', '# nothing\n', 'it is empty'],
    ['invalid UTF-8', Buffer.from([0x61, 0x3a, 0x20, 0xff]), 'it is not valid UTF-8'],
    ['a lone surrogate', 'a: "\uD800"', 'it is not valid Unicode text'],
    ['more than 50 aliases', `x: &x 1\n${Array.from({ length: 51 }, (_, index) => `a${index}: *x`).join('\n')}`, 'it uses more than 50 aliases'],
    ['nesting deeper than 64 levels', `a: ${'['.repeat(65)}${']'.repeat(65)}`, 'the document is nested deeper than 64 levels'],
  ])('rejects %s', (_name, input, reason) => {
    expect(parseError(input).reason).toBe(reason);
  });

  it('rejects alias expansion attacks', () => {
    const levels = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (let level = 1; level < 9; level += 1) {
      const previous = String.fromCharCode(96 + level);
      levels.push(`${String.fromCharCode(97 + level)}: &${String.fromCharCode(97 + level)} [${Array(5).fill(`*${previous}`).join(', ')}]`);
    }

    expect(parseError(levels.join('\n')).reason).toBe('its aliases expand too far');
  });

  it('enforces the size limit on bytes, not characters', () => {
    const exactly = `a: "${'x'.repeat(maxDocumentBytes - 5)}"`;

    expect(Buffer.byteLength(exactly)).toBe(maxDocumentBytes);
    expect(() => parseStrictYaml(exactly)).not.toThrow();
    expect(parseError(`a: "${'é'.repeat(maxDocumentBytes / 2)}"`).reason).toBe(`it exceeds the ${maxDocumentBytes}-byte size limit`);
    expect(() => parseStrictYaml('a: 12345', { maxBytes: 4 })).toThrow('size limit');
  });

  it('never quotes the source in errors', () => {
    for (const input of ['secret: [DO_NOT_ECHO_THIS', 'secret: "DO_NOT_ECHO_THIS', 'DO_NOT_ECHO_THIS: 1\nDO_NOT_ECHO_THIS: 2', 'a: !DO_NOT_ECHO_THIS x']) {
      const error = parseError(input);

      expect(error.message).not.toContain('DO_NOT_ECHO_THIS');
      expect(JSON.stringify(error)).not.toContain('DO_NOT_ECHO_THIS');
    }
  });
});
