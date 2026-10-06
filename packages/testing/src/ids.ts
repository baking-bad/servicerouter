import type { IdGenerator } from '@servicerouter/common';

export interface FakeIdGenerator extends IdGenerator {
  // Every ID handed out, in order
  readonly issued: readonly string[];
}

/** Hands out `id-1`, `id-2`, … so tests can name the IDs they expect (CK-5). */
export const createFakeIdGenerator = (prefix = 'id-'): FakeIdGenerator => {
  const issued: string[] = [];

  return {
    issued,
    next: () => {
      const id = `${prefix}${issued.length + 1}`;
      issued.push(id);

      return id;
    },
  };
};
