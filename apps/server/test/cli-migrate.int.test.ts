// SPEC-004 §9 `surface migrate`: the database part of startup (§8 steps 2–4), then exit.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateCommand } from '../src/cli/migrate.js';
import { createTestDatabase, type TestDatabase } from './db.js';
import { captureLogs, freePort, testConfig, VALID_ENV } from './helpers.js';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));

let db: TestDatabase | undefined;
afterEach(async () => {
  await db?.drop();
  db = undefined;
});

async function migrateWithLogs(databaseUrl: string, databaseWaitMs?: number) {
  const logs = captureLogs();
  const code = await migrateCommand(testConfig({ databaseUrl }), {
    logger: pino({ level: 'info' }, logs.stream),
    info: { version: '1.2.3', commit: 'test' },
    ...(databaseWaitMs === undefined ? {} : { databaseWaitMs }),
  });
  return { code, logs: logs.lines };
}

describe('surface migrate', () => {
  it('creates extensions and applies every migration, then does nothing on a second run', async () => {
    db = await createTestDatabase({ migrated: false });

    const first = await migrateWithLogs(db.url);
    expect(first.code).toBe(0);
    expect(first.logs.map((l) => l.msg)).toEqual(
      expect.arrayContaining([
        'created PostgreSQL extension',
        'applied migration',
        'migrations applied',
      ]),
    );
    const { rows } = await db.pool.query<{ tag: string; applied_by_version: string }>(
      'SELECT tag, applied_by_version FROM schema_migrations ORDER BY idx',
    );
    expect(rows[0]).toEqual({ tag: '0000_extensions', applied_by_version: '1.2.3' });

    const second = await migrateWithLogs(db.url);
    expect(second.code).toBe(0);
    expect(second.logs.at(-1)).toMatchObject({ msg: 'nothing to migrate', applied: 0 });
  });

  it('exits 1 with the E7 message when the database is newer than this build', async () => {
    db = await createTestDatabase();
    await db.pool.query(
      "INSERT INTO schema_migrations (idx, tag, hash, applied_by_version) VALUES (999, '0999_future', 'x', '9.9.9')",
    );
    const { code, logs } = await migrateWithLogs(db.url);
    expect(code).toBe(1);
    expect(logs.at(-1)).toMatchObject({
      level: 60,
      msg: expect.stringContaining('Database was migrated by a newer Surface (9.9.9)') as string,
    });
  });

  it('exits 1 when the database stays unreachable (E1)', async () => {
    const url = new URL(testConfig().databaseUrl);
    url.hostname = '127.0.0.1';
    url.port = String(await freePort());
    const { code, logs } = await migrateWithLogs(url.toString(), 300);
    expect(code).toBe(1);
    expect(logs.at(-1)).toMatchObject({
      level: 60,
      msg: expect.stringContaining('Could not reach the database at 127.0.0.1') as string,
    });
    expect(JSON.stringify(logs)).not.toContain(VALID_ENV.POSTGRES_PASSWORD);
  });

  it('runs from the command line and exits 0', async () => {
    db = await createTestDatabase({ migrated: false });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--conditions=@surface/source', '--import', 'tsx', 'src/cli/main.ts', 'migrate'],
      {
        cwd: serverRoot,
        env: { PATH: process.env.PATH, ...VALID_ENV, DATABASE_URL: db.url },
        timeout: 30_000,
      },
    );
    const messages = stdout
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { msg: string }).msg);
    expect(messages).toContain('migrations applied');
    const { rowCount } = await db.pool.query('SELECT 1 FROM schema_migrations');
    expect(rowCount).toBeGreaterThan(0);
  });
});
