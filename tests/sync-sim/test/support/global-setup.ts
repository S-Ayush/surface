/**
 * Setup for the real-server properties (`pnpm test:int`, PLAN-002 S9 part 2):
 * Postgres 17 from `TEST_DATABASE_URL` (CI's service container) or a
 * Testcontainers container, and a migrated template each case clones.
 */
import { createTemplateDatabase, startTestPostgres } from '@surface/server/testing';
import type { TestProject } from 'vitest/node';

/** Its own name, so the server's suite on the same cluster never shares it. */
const TEMPLATE = 'sync_sim_template';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser URL of the test cluster. */
    pgAdminUrl: string;
    /** Migrated template database to clone per case. */
    pgTemplateDb: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const postgres = await startTestPostgres(process.env.TEST_DATABASE_URL || undefined);
  try {
    await createTemplateDatabase(postgres.adminUrl, TEMPLATE);
  } catch (error) {
    await postgres.stop();
    throw error;
  }
  project.provide('pgAdminUrl', postgres.adminUrl);
  project.provide('pgTemplateDb', TEMPLATE);
  return () => postgres.stop();
}
