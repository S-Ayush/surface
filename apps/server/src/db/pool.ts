/**
 * Postgres connection pool and the startup wait for the database
 * (SPEC-004 §8 step 2, E1).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import type { Logger } from 'pino';
import { StartupError } from '../startup-error.js';

export type Pool = pg.Pool;

/** A pool or a single checked-out connection: anything that can run a query. */
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string, log: Logger, options: { max?: number } = {}): Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    application_name: 'surface',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client can fail (e.g. the database restarts). Without a listener
  // this is an unhandled 'error' event and crashes the process.
  pool.on('error', (err) => log.error({ err }, 'idle database connection failed'));
  return pool;
}

/** Host and port from a database URL, without credentials (safe to log). */
export function databaseLocation(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

/**
 * Errors that retrying will not fix: fail fast with a clear message. The
 * server's own reason is appended; Postgres never includes the password in it.
 */
export function permanentProblem(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  const advice = (() => {
    switch (code) {
      case '28P01':
        return 'The database rejected the username or password in DATABASE_URL (or POSTGRES_PASSWORD). Check that they match the database server.';
      case '28000':
        // invalid_authorization_specification: usually a pg_hba.conf rule, e.g.
        // the server only accepts TLS connections from this host.
        return 'The database server refused this connection (pg_hba.conf). If it requires TLS, add ?sslmode=require to DATABASE_URL; otherwise ask its administrator to allow this host, user and database.';
      case '3D000':
        return 'The database named in DATABASE_URL does not exist. Create it, or fix the name in DATABASE_URL.';
      default:
        return undefined;
    }
  })();
  return advice && `${advice} (${describe(error)})`;
}

function describe(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const message = typeof e?.message === 'string' ? e.message : String(error);
  return code ? `${code}: ${message}` : message;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  log: Logger;
  databaseUrl: string;
}

/**
 * Wait until the database accepts queries. Transient failures (container still
 * starting, DNS not ready) are retried until `timeoutMs`. Wrong credentials or a
 * missing database fail immediately.
 */
export async function waitForDatabase(
  pool: Pool,
  { timeoutMs = 60_000, intervalMs = 1_000, log, databaseUrl }: WaitOptions,
): Promise<void> {
  const where = databaseLocation(databaseUrl);
  const deadline = Date.now() + timeoutMs;
  let lastWarnAt = 0;

  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      const permanent = permanentProblem(error);
      if (permanent)
        throw new StartupError(`${permanent} (database at ${where})`, { cause: error });

      if (Date.now() >= deadline) {
        throw new StartupError(
          `Could not reach the database at ${where} after ${Math.round(timeoutMs / 1000)} s (${describe(error)}). Check that it is running and that DATABASE_URL points to it.`,
          { cause: error },
        );
      }
      if (Date.now() - lastWarnAt >= 5_000) {
        lastWarnAt = Date.now();
        log.warn({ database: where, reason: describe(error) }, 'waiting for database…');
      }
      await sleep(intervalMs);
    }
  }
}
