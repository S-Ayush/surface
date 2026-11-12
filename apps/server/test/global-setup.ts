/**
 * Integration-test setup (runs once per `pnpm test:int`):
 * - Postgres 17 from `TEST_DATABASE_URL` (CI service container, superuser URL), or
 *   a Testcontainers container on the current Docker context (Colima locally).
 * - A template database with extensions and all migrations applied, so each test
 *   file clones a ready database in milliseconds (see test/db.ts).
 *
 * Both through `support/postgres.ts`, which the sync simulation's real-server suite uses too.
 */
import type { TestProject } from 'vitest/node';
import { createTemplateDatabase, startTestPostgres } from './support/postgres.js';

export const TEMPLATE_DB = 'surface_test_template';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser URL of the test cluster (any database name). */
    pgAdminUrl: string;
    /** Migrated template database to clone. */
    pgTemplateDb: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const postgres = await startTestPostgres(process.env.TEST_DATABASE_URL || undefined);
  try {
    await createTemplateDatabase(postgres.adminUrl, TEMPLATE_DB);
  } catch (error) {
    await postgres.stop();
    throw error;
  }
  project.provide('pgAdminUrl', postgres.adminUrl);
  project.provide('pgTemplateDb', TEMPLATE_DB);
  return () => postgres.stop();
}
