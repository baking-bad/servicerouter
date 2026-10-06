import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const source = fileURLToPath(new URL('../src/', import.meta.url));

describe('the payments package (PR-11)', () => {
  it('imports nothing from Fastify or Drizzle, nor from the packages that wire them', async () => {
    const files = (await readdir(source, { recursive: true })).filter(file => file.endsWith('.ts'));
    const imports = await Promise.all(files.map(async file => {
      const text = await readFile(path.join(source, file), 'utf8');

      return [...text.matchAll(/from\s+'([^']+)'/g)].map(match => ({ file, specifier: match[1]! }));
    }));
    const forbidden = /^(?:fastify|@fastify\/.*|drizzle-orm|drizzle-kit|pg|redis|@servicerouter\/(?:db|api|proxy|workers))(?:\/|$)/;

    expect(files.length).toBeGreaterThan(0);
    expect(imports.flat().filter(({ specifier }) => forbidden.test(specifier))).toEqual([]);
  });
});
