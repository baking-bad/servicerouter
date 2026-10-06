import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

const packageNames = ['common', 'core', 'db', 'payments', 'proxy', 'api', 'workers', 'signer', 'web', 'testing'];
const appNames = ['proxy', 'api', 'workers', 'signer', 'web'];

const alias = Object.fromEntries(packageNames.map(name => [
  `@servicerouter/${name}`,
  fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url)),
]));

// Unit tests live in tests/, integration tests in tests/integration/, functional tests in tests/functional/.
const unitProject = (name: string) => ({
  resolve: { alias },
  test: {
    name,
    include: [`packages/${name}/tests/**/*.test.ts`],
    exclude: [...configDefaults.exclude, `packages/${name}/tests/integration/**`, `packages/${name}/tests/functional/**`],
  },
});

const levelProject = (name: string, level: 'integration' | 'functional') => ({
  resolve: { alias },
  test: {
    name: `${name}:${level}`,
    include: [`packages/${name}/tests/${level}/**/*.test.ts`],
  },
});

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      ...packageNames.map(unitProject),
      ...packageNames.map(name => levelProject(name, 'integration')),
      ...appNames.map(name => levelProject(name, 'functional')),
    ],
  },
});
