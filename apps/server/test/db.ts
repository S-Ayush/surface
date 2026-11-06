/**
 * Per-test-file databases for integration tests.
 *
 *   const db = await createTestDatabase();            // clone of the migrated template
 *   const empty = await createTestDatabase({ migrated: false });
 *   afterAll(() => db.drop());
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pino } from 'pino';
import { inject } from 'vitest';
import { LOCKS } from '../src/db/locks.js';

export const silentLog = pino({ level: 'silent' });

/** Superuser URL for `database` on the test cluster. */
export function testDatabaseUrl(database: string): string {
  const url = new URL(inject('pgAdminUrl'));
  url.pathname = `/${database}`;
  return url.toString();
}

export async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDatabaseUrl('postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export interface TestDatabase {
  name: string;
  url: string;
  pool: pg.Pool;
  drop: () => Promise<void>;
}

export async function createTestDatabase({ migrated = true } = {}): Promise<TestDatabase> {
  // Random lowercase hex: always a safe identifier.
  const name = `t_${randomBytes(6).toString('hex')}`;
  await withAdmin(async (client) => {
    // Cloning a template is not safe to run concurrently; serialise across test workers.
    await client.query('SELECT pg_advisory_lock($1)', [LOCKS.testDatabases]);
    try {
      const template = migrated ? ` TEMPLATE ${inject('pgTemplateDb')}` : '';
      await client.query(`CREATE DATABASE ${name}${template}`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCKS.testDatabases]);
    }
  });

  const url = testDatabaseUrl(name);
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return {
    name,
    url,
    pool,
    drop: async () => {
      await pool.end();
      await withAdmin((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}

/** Run `fn` in a transaction that is always rolled back. */
export async function withTx<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Write a drizzle-kit style migrations folder (journal + SQL files) for tests. */
export function writeMigrations(entries: { tag: string; sql: string }[], dir?: string): string {
  const root = dir ?? mkdtempSync(path.join(tmpdir(), 'surface-migrations-'));
  mkdirSync(path.join(root, 'meta'), { recursive: true });
  writeFileSync(
    path.join(root, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: entries.map((e, idx) => ({
        idx,
        version: '7',
        when: idx,
        tag: e.tag,
        breakpoints: true,
      })),
    }),
  );
  for (const e of entries) writeFileSync(path.join(root, `${e.tag}.sql`), e.sql);
  return root;
}
