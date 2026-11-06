/**
 * Schema migrations (SPEC-004 §8 step 3, E2, E7).
 *
 * Migrations are the SQL files drizzle-kit generates in `migrations/`, listed in
 * order by `migrations/meta/_journal.json`. They run:
 * - under `pg_advisory_lock(LOCKS.migrations)`, so concurrent replicas wait their turn (E2).
 *   `beforeMigrate` (extension creation at startup) runs under the same lock;
 * - each in its own transaction, so a failure leaves the database unchanged;
 * - forward only. History lives in `schema_migrations`, which also records the
 *   Surface version that applied each one, so an older image can refuse to start
 *   on a newer schema (E7).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import type { Logger } from 'pino';
import { StartupError } from '../startup-error.js';
import { LOCKS } from './locks.js';
import type { Pool } from './pool.js';

export interface Migration {
  idx: number;
  tag: string;
  /** SHA-256 of the SQL file; detects edits to applied migrations. */
  hash: string;
  statements: string[];
}

interface AppliedMigration {
  idx: number;
  tag: string;
  hash: string;
  applied_by_version: string;
}

const BREAKPOINT = '--> statement-breakpoint';

/** The migrations shipped with this build (`apps/server/migrations`). */
export function defaultMigrationsDir(): string {
  // src/db/ and dist/db/ are both two levels below the package root.
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

/** Read the drizzle-kit journal and the SQL files it lists, in order. */
export function loadMigrations(dir: string = defaultMigrationsDir()): Migration[] {
  const journal = JSON.parse(readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map(({ idx, tag }) => {
      const sql = readFileSync(path.join(dir, `${tag}.sql`), 'utf8');
      return {
        idx,
        tag,
        hash: createHash('sha256').update(sql).digest('hex'),
        statements: sql
          .split(BREAKPOINT)
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      };
    });
}

const HISTORY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    idx                integer     PRIMARY KEY,
    tag                text        NOT NULL UNIQUE,
    hash               text        NOT NULL,
    applied_at         timestamptz NOT NULL DEFAULT now(),
    applied_by_version text        NOT NULL
  )`;

/** Throws if the database holds migrations this build does not know (E7) or edited ones. */
function verifyHistory(applied: AppliedMigration[], known: Migration[]): void {
  const knownByTag = new Map(known.map((m) => [m.tag, m]));

  const unknown = applied.filter((a) => !knownByTag.has(a.tag));
  if (unknown.length > 0) {
    const newest = unknown.reduce((a, b) => (b.idx > a.idx ? b : a));
    throw new StartupError(
      `Database was migrated by a newer Surface (${newest.applied_by_version}). Restore a backup or upgrade. (Unknown migration: ${newest.tag}.)`,
    );
  }

  for (const a of applied) {
    const m = knownByTag.get(a.tag);
    if (m && m.hash !== a.hash) {
      throw new StartupError(
        `Migration ${a.tag} has changed since it was applied. Applied migrations must never be edited: restore the original file and add a new migration instead.`,
      );
    }
  }
}

async function readHistory(client: PoolClient | Pool): Promise<AppliedMigration[]> {
  const { rows } = await client.query<AppliedMigration>(
    'SELECT idx, tag, hash, applied_by_version FROM schema_migrations ORDER BY idx',
  );
  return rows;
}

export interface MigrateOptions {
  log: Logger;
  /** Recorded with each migration so older builds can report who migrated (E7). */
  appVersion: string;
  migrations?: Migration[];
  /**
   * Runs on the lock-holding connection, before the history is read. Startup
   * creates extensions here so concurrent replicas never race on CREATE EXTENSION.
   * It gets that connection rather than using the pool, so a pool of one works.
   */
  beforeMigrate?: (client: PoolClient) => Promise<void>;
}

export interface MigrateResult {
  applied: string[];
}

/** Take the migrations lock, saying so when another instance holds it (E2). */
async function acquireMigrationsLock(client: PoolClient, log: Logger): Promise<void> {
  const { rows } = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [LOCKS.migrations],
  );
  if (rows[0]?.locked) return;
  log.info('waiting for another instance to finish migrations');
  await client.query('SELECT pg_advisory_lock($1)', [LOCKS.migrations]);
}

export async function migrate(
  pool: Pool,
  { log, appVersion, migrations = loadMigrations(), beforeMigrate }: MigrateOptions,
): Promise<MigrateResult> {
  const client = await pool.connect();
  // A connection whose state we can't trust (lock possibly still held, aborted
  // transaction) is destroyed rather than returned to the pool.
  let discard = false;
  try {
    await acquireMigrationsLock(client, log);
    try {
      await beforeMigrate?.(client);
      return await applyPending(client, log, appVersion, migrations);
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCKS.migrations]);
      } catch (err) {
        // Closing the session releases the lock too.
        discard = true;
        log.warn({ err }, 'could not release the migrations lock; closing the connection instead');
      }
    }
  } catch (error) {
    discard = true;
    throw error;
  } finally {
    client.release(discard);
  }
}

async function applyPending(
  client: PoolClient,
  log: Logger,
  appVersion: string,
  migrations: Migration[],
): Promise<MigrateResult> {
  await client.query(HISTORY_TABLE_SQL);
  const history = await readHistory(client);
  verifyHistory(history, migrations);

  const done = new Set(history.map((h) => h.tag));
  const pending = migrations.filter((m) => !done.has(m.tag));
  if (pending.length === 0) {
    log.info({ count: migrations.length }, 'database schema is current');
    return { applied: [] };
  }

  for (const m of pending) {
    const started = Date.now();
    try {
      await client.query('BEGIN');
      for (const statement of m.statements) await client.query(statement);
      await client.query(
        'INSERT INTO schema_migrations (idx, tag, hash, applied_by_version) VALUES ($1, $2, $3, $4)',
        [m.idx, m.tag, m.hash, appVersion],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const reason = error instanceof Error ? error.message : String(error);
      throw new StartupError(
        `Migration ${m.tag} failed and was rolled back; the database is unchanged by it. ${reason}`,
        { cause: error },
      );
    }
    log.info({ migration: m.tag, durationMs: Date.now() - started }, 'applied migration');
  }
  return { applied: pending.map((m) => m.tag) };
}

/**
 * Readiness check: "current" when every migration of this build is applied and
 * the database has none it doesn't know. Throws otherwise.
 */
export async function migrationStatus(pool: Pool, migrations: Migration[]): Promise<string> {
  const applied = await readHistory(pool);
  verifyHistory(applied, migrations);
  if (applied.length < migrations.length) throw new Error('migrations pending');
  return 'current';
}
