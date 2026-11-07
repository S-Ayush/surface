/**
 * Postgres for suites outside this app that run the real server (`@surface/server/testing`):
 * the sync simulation's real-server properties (PLAN-002 S9 part 2). The same steps as this
 * app's own `global-setup.ts` and `db.ts`, without Vitest's `inject`, and with a template name
 * of the caller's, so two suites on one cluster (CI's service container) never share one.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { pino } from 'pino';
import { LOCKS } from '../../src/db/locks.js';
import { createPool } from '../../src/db/pool.js';
import { prepareDatabase } from '../../src/db/prepare.js';

export interface TestPostgres {
  /** Superuser URL of the cluster, on database `postgres`. */
  readonly adminUrl: string;
  stop(): Promise<void>;
}

export interface TestDatabaseHandle {
  readonly url: string;
  /** Waits for its connections to close, then drops it. */
  drop(): Promise<void>;
}

/** How long `drop()` waits for connections to close before terminating them. */
const DROP_WAIT_MS = 10_000;

/**
 * The cluster at `url` (a superuser URL, as CI provides), or Postgres 17 in a Testcontainers
 * container on the active Docker context (Colima locally).
 */
export async function startTestPostgres(url?: string): Promise<TestPostgres> {
  if (url !== undefined) return { adminUrl: onDatabase(url, 'postgres'), stop: async () => {} };
  useActiveDockerContext();
  const container = await new PostgreSqlContainer('postgres:17').start();
  return {
    adminUrl: onDatabase(container.getConnectionUri(), 'postgres'),
    stop: async () => {
      await container.stop();
    },
  };
}

/** A migrated template database named `name`, replacing one left by an earlier run. */
export async function createTemplateDatabase(adminUrl: string, name: string): Promise<void> {
  await withAdmin(adminUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${identifier(name)} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${identifier(name)}`);
  });
  const log = pino({ level: 'silent' });
  const pool = createPool(onDatabase(adminUrl, name), log, { max: 1 });
  try {
    await prepareDatabase(pool, { log, appVersion: 'test' });
  } finally {
    await pool.end(); // a template must have no open connections when cloned
  }
}

/** A new database cloned from `template`. */
export async function createDatabaseFrom(
  adminUrl: string,
  template: string,
): Promise<TestDatabaseHandle> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  await withAdmin(adminUrl, async (client) => {
    // Cloning a template is not safe to run concurrently; serialise with every suite on the cluster.
    await client.query('SELECT pg_advisory_lock($1)', [LOCKS.testDatabases]);
    try {
      await client.query(`CREATE DATABASE ${name} TEMPLATE ${identifier(template)}`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCKS.testDatabases]);
    }
  });
  return {
    url: onDatabase(adminUrl, name),
    drop: () =>
      withAdmin(adminUrl, async (client) => {
        // As in `db.ts`: wait for pools that are still closing; FORCE only clears leaks.
        const deadline = performance.now() + DROP_WAIT_MS;
        while (performance.now() < deadline) {
          const { rows } = await client.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
            [name],
          );
          if (rows[0]?.n === 0) break;
          await delay(20);
        }
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }),
  };
}

async function withAdmin<T>(adminUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function onDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Template names come from the caller: allow plain lowercase identifiers only. */
function identifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new RangeError(
      `Database names here are lowercase letters, digits and _ (got "${name}").`,
    );
  }
  return name;
}

/** Testcontainers does not read Docker contexts; point it at the active one (as `global-setup.ts`). */
function useActiveDockerContext(): void {
  if (process.env.DOCKER_HOST) return;
  try {
    const host = execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { encoding: 'utf8' },
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
