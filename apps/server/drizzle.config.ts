// drizzle-kit: generates SQL migrations from the schema (ADR-0006).
// Usage: pnpm --filter @surface/server db:generate [--name <name>] [--custom]
// Generated migrations are reviewed and committed, and never edited once committed.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './migrations',
  casing: 'snake_case',
});
