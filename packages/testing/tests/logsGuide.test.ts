import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Build metadata carried by the images and CI (L-1).

const repoFile = (path: string): Promise<string> => readFile(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

describe('the images\' commit (L-1)', () => {
  it.each(['Dockerfile', 'packages/web/Dockerfile'])('%s sets GIT_SHA from a build argument', async path => {
    expect(await repoFile(path)).toMatch(/ARG GIT_SHA=""\nENV GIT_SHA=\$\{GIT_SHA\}/);
  });

  it('CI passes the commit to both image builds', async () => {
    const ci = await repoFile('.github/workflows/ci.yml');

    expect(ci.match(/build-args: \|\n\s+GIT_SHA=\$\{\{ github\.sha \}\}/g)).toHaveLength(2);
  });
});
