import { describe, expect, it } from 'vitest';

import { createFakeIdGenerator } from '../src/index.js';

describe('createFakeIdGenerator (CK-5)', () => {
  it('hands out numbered IDs and records them', () => {
    const ids = createFakeIdGenerator('key-');

    expect([ids.next(), ids.next()]).toEqual(['key-1', 'key-2']);
    expect(ids.issued).toEqual(['key-1', 'key-2']);
    expect(createFakeIdGenerator().next()).toBe('id-1');
  });
});
