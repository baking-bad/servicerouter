import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { configDefaults, defineConfig } from 'vitest/config';

const packageNames = ['common', 'core', 'db', 'payments', 'proxy', 'api', 'workers', 'signer', 'web', 'testing'];
const appNames = ['proxy', 'api', 'workers', 'signer', 'web'];

const alias = Object.fromEntries(packageNames.map(name => [
  `@servicerouter/${name}`,
  fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url)),
]));

// Integration and functional tests read TEST_DATABASE_URL and TEST_REDIS_URL from .env. Variables
// already set win, so CI sets its own.
const envFile = new URL('./.env', import.meta.url);
const env = existsSync(envFile)
  ? Object.fromEntries(Object.entries(parseEnv(readFileSync(envFile, 'utf8')))
    .filter(([name]) => name.startsWith('TEST_') && process.env[name] === undefined))
  : {};

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
    env,
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
