import { describe, expect, it } from 'vitest';

import { createTestRedis } from '../../src/index.js';

describe('createTestRedis', () => {
  it('gives each caller its own prefix, and cleanup deletes only that prefix\'s keys', async () => {
    const [first, second] = await Promise.all([createTestRedis(), createTestRedis()]);
    try {
      expect(first.prefix).not.toBe(second.prefix);
      await first.client.set(`${first.prefix}a`, '1');
      await first.client.set(`${first.prefix}nested:b`, '2');
      await second.client.set(`${second.prefix}a`, '3');

      await first.cleanup();

      expect(await second.client.exists([`${first.prefix}a`, `${first.prefix}nested:b`])).toBe(0);
      expect(await second.client.get(`${second.prefix}a`)).toBe('3');
    }
    finally {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }
  });
});
