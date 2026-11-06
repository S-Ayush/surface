// SPEC-004 §8 startup sequence. AC-9: /readyz is 503 while migrations run, 200
// once ready with db and migration checks, and the pool is released on shutdown.
// E2: concurrent replicas. E7: newer schema. E8: incompatible database.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { buildInfo } from '../src/build-info.js';
import { LOCKS } from '../src/db/locks.js';
import { loadMigrations } from '../src/db/migrate.js';
import { startServer, type RunningServer } from '../src/server.js';
import { gracefulShutdown } from '../src/shutdown.js';
import {
  createTestDatabase,
  silentLog,
  testDatabaseUrl,
  withAdmin,
  type TestDatabase,
} from './db.js';
import { captureLogs, freePort, testConfig, VALID_ENV } from './helpers.js';

const servers: RunningServer[] = [];
let db: TestDatabase | undefined;
afterEach(async () => {
  for (const s of servers.splice(0)) {
    if (s.lifecycle.state !== 'draining') {
      await gracefulShutdown({ app: s.app, lifecycle: s.lifecycle, log: silentLog });
    }
  }
  await db?.drop();
  db = undefined;
});

async function start(
  url: string,
  options: Parameters<typeof startServer>[1] = {},
): Promise<RunningServer> {
  const server = await startServer(testConfig({ databaseUrl: url, port: 0, host: '127.0.0.1' }), {
    logger: silentLog,
    ...options,
  });
  servers.push(server);
  return server;
}

async function readyz(server: RunningServer) {
  const res = await server.app.inject({ url: '/readyz' });
  return { status: res.statusCode, body: res.json<Record<string, unknown>>() };
}

/** Poll `condition` until it holds, failing after `timeoutMs` (no fixed sleeps). */
async function until(condition: () => Promise<boolean>, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(20);
  }
}

async function tableExists(pool: pg.Pool, table: string): Promise<boolean> {
  const { rows } = await pool.query<{ t: string | null }>('SELECT to_regclass($1) AS t', [table]);
  return rows[0]?.t != null;
}

describe('startup sequence', () => {
  it('is not ready while migrations wait for the lock, then ready with db and migrations checks', async () => {
    db = await createTestDatabase({ migrated: false });
    // Another "replica" holds the migrations lock, so startup stops at step 3.
    const holder = new pg.Client({ connectionString: db.url });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [LOCKS.migrations]);
    try {
      const logs = captureLogs();
      const server = await start(db.url, { logger: pino({ level: 'info' }, logs.stream) });

      await until(async () => {
        const { rowCount } = await holder.query(
          "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
        );
        return rowCount === 1;
      }, 'the server to wait for the migrations lock');
      expect(await readyz(server)).toMatchObject({ status: 503, body: { status: 'starting' } });
      expect((await server.app.inject({ url: '/healthz' })).statusCode).toBe(200);
      expect(logs.lines.map((l) => l.msg)).toContain(
        'waiting for another instance to finish migrations',
      );

      await holder.query('SELECT pg_advisory_unlock($1)', [LOCKS.migrations]);
      await server.ready;
      expect(await readyz(server)).toEqual({
        status: 200,
        body: { status: 'ready', db: 'ok', migrations: 'current', version: buildInfo().version },
      });
    } finally {
      await holder.end();
    }
  });

  it('brings concurrent replicas up on one empty database (E2)', async () => {
    db = await createTestDatabase({ migrated: false }); // no pg_trgm yet
    const replicas = await Promise.all([1, 2, 3, 4].map(() => start(db!.url)));
    await Promise.all(replicas.map((r) => r.ready));

    const { rowCount } = await db.pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'",
    );
    expect(rowCount).toBe(1);
    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM schema_migrations',
    );
    expect(Number(rows[0]?.n)).toBe(loadMigrations().length);
  });

  it('changes nothing when the database is incompatible (E8)', async () => {
    db = await createTestDatabase({ migrated: false });
    // A user that may create tables but not extensions.
    const role = `limited_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(12).toString('hex');
    await withAdmin(async (c) => {
      await c.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await c.query(`GRANT CONNECT ON DATABASE ${db!.name} TO ${role}`);
    });
    await db.pool.query(`GRANT CREATE ON SCHEMA public TO ${role}`);
    const url = new URL(db.url);
    url.username = role;
    url.password = password;
    try {
      const server = await start(url.toString());
      await expect(server.ready).rejects.toThrow(
        'The PostgreSQL extension pg_trgm is not installed and the database user is not allowed to create it',
      );
      expect(await tableExists(db.pool, 'public.schema_migrations')).toBe(false);
      expect((await readyz(server)).status).toBe(503);
    } finally {
      for (const s of servers.splice(0)) {
        await gracefulShutdown({ app: s.app, lifecycle: s.lifecycle, log: silentLog });
      }
      await db.pool.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
      await withAdmin(async (c) => {
        await c.query(`REVOKE CONNECT ON DATABASE ${db!.name} FROM ${role}`);
        await c.query(`DROP ROLE ${role}`);
      });
    }
  });

  it('fails startup with a StartupError and stays unready when the schema is newer (E7)', async () => {
    db = await createTestDatabase(); // migrated template
    await db.pool.query(
      "INSERT INTO schema_migrations (idx, tag, hash, applied_by_version) VALUES (999, '0999_future', 'x', '9.9.0')",
    );
    const server = await start(db.url);
    await expect(server.ready).rejects.toThrow('Database was migrated by a newer Surface (9.9.0)');
    expect((await readyz(server)).status).toBe(503);
  });

  it('closes the database pool on shutdown', async () => {
    db = await createTestDatabase();
    const server = await start(db.url);
    await server.ready;
    await gracefulShutdown({ app: server.app, lifecycle: server.lifecycle, log: silentLog });
    expect(server.pool.ended).toBe(true);
  });
});

describe('surface serve', () => {
  const serverRoot = fileURLToPath(new URL('..', import.meta.url));

  it('exits 1 with one fatal log line, without secrets, when startup fails', async () => {
    // Wrong credentials fail fast (no retries), and the password is distinctive
    // enough to search the output for.
    const url = new URL(testDatabaseUrl('postgres'));
    url.password = `hunter2-${randomBytes(6).toString('hex')}`;

    const child = execFileAsync(
      process.execPath,
      ['--conditions=@surface/source', '--import', 'tsx', 'src/main.ts'],
      {
        cwd: serverRoot,
        env: {
          PATH: process.env.PATH,
          ...VALID_ENV,
          DATABASE_URL: url.toString(),
          PORT: String(await freePort()),
          HOST: '127.0.0.1',
          SURFACE_WEB_DIR: '/nonexistent-web-dir',
        },
        timeout: 20_000,
      },
    );
    const result = await child.then(
      () => ({ code: 0, stdout: '', stderr: '' }),
      (error: { code?: unknown; stdout?: string; stderr?: string }) => ({
        code: error.code,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      }),
    );

    expect(result.code).toBe(1);
    const lines = result.stdout
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { level: string; msg: string });
    const fatal = lines.filter((l) => l.level === 'fatal');
    expect(fatal).toHaveLength(1);
    expect(fatal[0]?.msg).toMatch(/^The database rejected the username or password/);
    expect(fatal[0]?.msg).toContain('28P01: password authentication failed');
    expect(`${result.stdout}${result.stderr}`).not.toContain(url.password);
    expect(`${result.stdout}${result.stderr}`).not.toContain(VALID_ENV.SESSION_SECRET);
  });
});

const execFileAsync = promisify(execFile);
