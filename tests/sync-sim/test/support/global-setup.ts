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

interface Cluster {
  readonly ready: Promise<{ readonly adminUrl: string; stop(): Promise<void> }>;
  users: number;
}

/**
 * Started once per run: `vitest.int.config.js` has two projects (its phases), and each runs this
 * setup. Both are in this process, so the first starts the cluster and the last stops it.
 */
declare global {
  var surfaceSyncSimCluster: Cluster | undefined;
}

async function startCluster(): Promise<{ adminUrl: string; stop(): Promise<void> }> {
  const postgres = await startTestPostgres(process.env.TEST_DATABASE_URL || undefined);
  try {
    await createTemplateDatabase(postgres.adminUrl, TEMPLATE);
  } catch (error) {
    await postgres.stop();
    throw error;
  }
  return postgres;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const cluster = (globalThis.surfaceSyncSimCluster ??= { ready: startCluster(), users: 0 });
  cluster.users += 1;
  const postgres = await cluster.ready;
  project.provide('pgAdminUrl', postgres.adminUrl);
  project.provide('pgTemplateDb', TEMPLATE);
  return async () => {
    cluster.users -= 1;
    if (cluster.users > 0) return;
    globalThis.surfaceSyncSimCluster = undefined;
    await postgres.stop();
  };
}
