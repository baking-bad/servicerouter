// Applies pending migrations to DATABASE_URL, then exits. Deployments run it as a one-off command from
// the same image before the apps roll (S1-D3): node packages/db/dist/migrate.js
import { createLogger, readSecret } from '@servicerouter/common';

import { migrateDatabase } from './migrations.js';

const logger = createLogger({ name: 'migrate' });

try {
  await migrateDatabase({ url: readSecret('DATABASE_URL'), logger });
}
catch (error) {
  logger.fatal({ error }, 'Migration failed');
  process.exitCode = 1;
}
