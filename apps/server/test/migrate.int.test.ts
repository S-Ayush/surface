// SPEC-004 §8 step 3: migrations under an advisory lock, one transaction each,
// E2 (concurrent replicas) and E7 (database newer than the code).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, migrationStatus } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { StartupError } from '../src/startup-error.js';
import { createTestDatabase, silentLog as log, writeMigrations, type TestDatabase } from './db.js';

const cleanup: TestDatabase[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((db) => db.drop()));
});

async function emptyDatabase() {
  const db = await createTestDatabase({ migrated: false });
  cleanup.push(db);
  return db;
}

async function tables(db: TestDatabase): Promise<string[]> {
  const { rows } = await db.pool.query<{ t: string }>(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
  );
  return rows.map((r) => r.t);
}

const fixture = () =>
  writeMigrations([
    { tag: '0000_first', sql: 'CREATE TABLE first (id int PRIMARY KEY);' },
    {
      tag: '0001_second',
      sql: 'CREATE TABLE second (id int);\n--> statement-breakpoint\nINSERT INTO second VALUES (1);',
    },
  ]);

describe('migrate', () => {
  it('applies every migration once, records who applied it, then is a no-op', async () => {
    const db = await emptyDatabase();
    const migrations = loadMigrations(fixture());

    expect(await migrate(db.pool, { log, appVersion: '0.1.0', migrations })).toEqual({
      applied: ['0000_first', '0001_second'],
    });
    expect(await tables(db)).toEqual(['first', 'schema_migrations', 'second']);
    const { rows } = await db.pool.query(
      'SELECT tag, applied_by_version FROM schema_migrations ORDER BY idx',
    );
    expect(rows).toEqual([
      { tag: '0000_first', applied_by_version: '0.1.0' },
      { tag: '0001_second', applied_by_version: '0.1.0' },
    ]);

    expect(await migrate(db.pool, { log, appVersion: '0.1.0', migrations })).toEqual({
      applied: [],
    });
    expect(await migrationStatus(db.pool, migrations)).toBe('current');
  });

  it('applies the shipped migrations (pg_trgm available afterwards)', async () => {
    const db = await emptyDatabase();
    await migrate(db.pool, { log, appVersion: 'test' });
    const { rowCount } = await db.pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'",
    );
    expect(rowCount).toBe(1);
  });

  it('serialises concurrent replicas: each migration runs exactly once (E2)', async () => {
    const db = await emptyDatabase();
    const migrations = loadMigrations(fixture());
    const pools = Array.from({ length: 5 }, () => createPool(db.url, log, { max: 1 }));
    try {
      const results = await Promise.all(
        pools.map((p) => migrate(p, { log, appVersion: '0.1.0', migrations })),
      );
      expect(results.flatMap((r) => r.applied).sort()).toEqual(['0000_first', '0001_second']);
      expect(results.filter((r) => r.applied.length === 0)).toHaveLength(4);
      const { rows } = await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM second');
      expect(rows[0]?.n).toBe(1);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it('rolls back a failing migration and keeps earlier ones', async () => {
    const db = await emptyDatabase();
    const dir = writeMigrations([
      { tag: '0000_ok', sql: 'CREATE TABLE ok (id int);' },
      {
        tag: '0001_bad',
        sql: 'CREATE TABLE half (id int);\n--> statement-breakpoint\nSELECT * FROM missing_table;',
      },
    ]);

    const run = migrate(db.pool, { log, appVersion: '0.1.0', migrations: loadMigrations(dir) });
    await expect(run).rejects.toThrow(StartupError);
    await expect(run).rejects.toThrow(
      /^Migration 0001_bad failed and was rolled back.*missing_table/,
    );
    expect(await tables(db)).toEqual(['ok', 'schema_migrations']);

    // Fix the (not yet applied) migration and retry.
    writeFileSync(path.join(dir, '0001_bad.sql'), 'CREATE TABLE half (id int);');
    expect(
      await migrate(db.pool, { log, appVersion: '0.1.0', migrations: loadMigrations(dir) }),
    ).toEqual({
      applied: ['0001_bad'],
    });
  });

  it('refuses to run when the database was migrated by a newer Surface (E7)', async () => {
    const db = await emptyDatabase();
    const migrations = loadMigrations(fixture());
    await migrate(db.pool, { log, appVersion: '0.1.0', migrations });
    await db.pool.query(
      "INSERT INTO schema_migrations (idx, tag, hash, applied_by_version) VALUES (2, '0002_from_the_future', 'x', '0.9.0')",
    );

    const message =
      'Database was migrated by a newer Surface (0.9.0). Restore a backup or upgrade.';
    await expect(migrate(db.pool, { log, appVersion: '0.1.0', migrations })).rejects.toThrow(
      message,
    );
    await expect(migrationStatus(db.pool, migrations)).rejects.toThrow(message);
  });

  it('refuses to run when an applied migration was edited', async () => {
    const db = await emptyDatabase();
    const dir = fixture();
    await migrate(db.pool, { log, appVersion: '0.1.0', migrations: loadMigrations(dir) });

    const file = path.join(dir, '0000_first.sql');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- sneaky edit`);
    await expect(
      migrate(db.pool, { log, appVersion: '0.1.0', migrations: loadMigrations(dir) }),
    ).rejects.toThrow(/^Migration 0000_first has changed since it was applied/);
  });

  it('reports pending migrations as not ready', async () => {
    const db = await emptyDatabase();
    const migrations = loadMigrations(fixture());
    await migrate(db.pool, { log, appVersion: '0.1.0', migrations: migrations.slice(0, 1) });
    await expect(migrationStatus(db.pool, migrations)).rejects.toThrow('migrations pending');
  });
});
