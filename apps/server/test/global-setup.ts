/**
 * Integration-test setup (runs once per `pnpm test:int`):
 * - Postgres 17 from `TEST_DATABASE_URL` (CI service container, superuser URL), or
 *   a Testcontainers container on the current Docker context (Colima locally).
 * - A template database with extensions and all migrations applied, so each test
 *   file clones a ready database in milliseconds (see test/db.ts).
 */
import { execFileSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { pino } from 'pino';
import type { TestProject } from 'vitest/node';
import { createPool } from '../src/db/pool.js';
import { prepareDatabase } from '../src/db/prepare.js';

export const TEMPLATE_DB = 'surface_test_template';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser URL of the test cluster (any database name). */
    pgAdminUrl: string;
    /** Migrated template database to clone. */
    pgTemplateDb: string;
  }
}

/** Testcontainers does not read Docker contexts; point it at the active one. */
function useActiveDockerContext(): void {
  if (process.env.DOCKER_HOST) return;
  try {
    const host = execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      {
        encoding: 'utf8',
      },
    ).trim();
    if (!host) return;
    process.env.DOCKER_HOST = host;
    // Inside the Docker VM the socket is at the standard path (needed by the Ryuk reaper).
    if (host !== 'unix:///var/run/docker.sock') {
      process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= '/var/run/docker.sock';
    }
  } catch {
    // No docker CLI: let Testcontainers report its own error.
  }
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let container: StartedPostgreSqlContainer | undefined;
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    useActiveDockerContext();
    container = await new PostgreSqlContainer('postgres:17').start();
    adminUrl = container.getConnectionUri();
  }
  adminUrl = withDatabase(adminUrl, 'postgres');

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

  const log = pino({ level: 'silent' });
  const pool = createPool(withDatabase(adminUrl, TEMPLATE_DB), log, { max: 1 });
  try {
    await prepareDatabase(pool, { log, appVersion: 'test' });
  } finally {
    await pool.end(); // a template must have no open connections when cloned
  }

  project.provide('pgAdminUrl', adminUrl);
  project.provide('pgTemplateDb', TEMPLATE_DB);

  return async () => {
    await container?.stop();
  };
}
