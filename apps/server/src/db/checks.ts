/**
 * Postgres compatibility checks run before migrations (SPEC-004 §8 step 4, E8).
 */
import type { Logger } from 'pino';
import { StartupError } from '../startup-error.js';
import type { Queryable } from './pool.js';

export const MIN_POSTGRES_MAJOR = 17;
export const REQUIRED_EXTENSIONS = ['pg_trgm'] as const;

/** Throws unless `server_version_num` is at least the supported major version. */
export function assertSupportedVersion(versionNum: number, versionText: string): void {
  if (!Number.isInteger(versionNum) || versionNum < MIN_POSTGRES_MAJOR * 10_000) {
    throw new StartupError(
      `Surface needs PostgreSQL ${MIN_POSTGRES_MAJOR} or newer, but the database is running ${versionText}. Upgrade PostgreSQL (the bundled compose file uses postgres:${MIN_POSTGRES_MAJOR}).`,
    );
  }
}

export async function checkPostgresVersion(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ num: string; text: string }>(
    "SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS text",
  );
  const row = rows[0];
  if (!row) throw new StartupError('Could not read the PostgreSQL server version.');
  assertSupportedVersion(Number(row.num), row.text);
  return row.text;
}

/**
 * Make sure each required extension is installed, creating it when the database
 * user is allowed to. Otherwise exit with the exact SQL an administrator must run.
 */
export async function ensureExtensions(
  db: Queryable,
  log: Logger,
  extensions: readonly string[] = REQUIRED_EXTENSIONS,
): Promise<void> {
  for (const name of extensions) {
    const installed = await db.query('SELECT 1 FROM pg_extension WHERE extname = $1', [name]);
    if (installed.rowCount) continue;

    const available = await db.query('SELECT 1 FROM pg_available_extensions WHERE name = $1', [
      name,
    ]);
    if (!available.rowCount) {
      throw new StartupError(
        `The PostgreSQL extension ${name} is not available on this server. Install the PostgreSQL contrib package, or enable ${name} in your database provider's settings.`,
      );
    }

    try {
      // `name` comes from the fixed list above, never from user input.
      await db.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(name)}`);
      log.info({ extension: name }, 'created PostgreSQL extension');
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      // Another process created it between our check and CREATE (startup runs this
      // under the migrations lock, but other tools may not): installed is installed.
      if (code === '23505' || code === '42710') {
        const recheck = await db.query('SELECT 1 FROM pg_extension WHERE extname = $1', [name]);
        if (recheck.rowCount) continue;
      }
      if (code === '42501') {
        const { rows } = await db.query<{ db: string }>('SELECT current_database() AS db');
        throw new StartupError(
          `The PostgreSQL extension ${name} is not installed and the database user is not allowed to create it. Ask a database administrator to run this in database "${rows[0]?.db ?? '?'}": CREATE EXTENSION ${name};`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
