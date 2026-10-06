import { defineConfig } from 'drizzle-kit';

// `npm run db:generate` writes a migration for every schema change. Migrations are committed and ship in
// the image; `npm run db:migrate` applies them.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
});
