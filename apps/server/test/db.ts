/**
 * Per-test-file databases for integration tests.
 *
 *   const db = await createTestDatabase();            // clone of the migrated template
 *   const empty = await createTestDatabase({ migrated: false });
 *   afterAll(() => db.drop());
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pino } from 'pino';
import { inject } from 'vitest';
import { createDatabase } from './support/postgres.js';

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

/** A database of its own for one test file: cloned from the migrated template, or empty. */
export async function createTestDatabase({ migrated = true } = {}): Promise<TestDatabase> {
  const database = await createDatabase(
    inject('pgAdminUrl'),
    migrated ? inject('pgTemplateDb') : undefined,
  );
  const pool = new pg.Pool({ connectionString: database.url, max: 5 });
  return {
    name: database.name,
    url: database.url,
    pool,
    drop: async () => {
      await pool.end();
      await database.drop();
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
