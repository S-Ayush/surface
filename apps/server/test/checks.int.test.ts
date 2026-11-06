// SPEC-004 §8 step 4 / E8: PostgreSQL version and required extensions.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPostgresVersion, ensureExtensions } from '../src/db/checks.js';
import { createPool } from '../src/db/pool.js';
import { createTestDatabase, silentLog as log, withAdmin, type TestDatabase } from './db.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ migrated: false });
});
afterAll(async () => {
  await db.drop();
});

describe('database checks', () => {
  it('accepts the PostgreSQL 17 test server', async () => {
    expect(await checkPostgresVersion(db.pool)).toMatch(/^17\./);
  });

  it('creates pg_trgm when it is missing and the user may create it', async () => {
    await db.pool.query('DROP EXTENSION IF EXISTS pg_trgm');
    await ensureExtensions(db.pool, log);
    const { rowCount } = await db.pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'",
    );
    expect(rowCount).toBe(1);
    await ensureExtensions(db.pool, log); // idempotent
  });

  it('tolerates other processes creating the extension at the same moment', async () => {
    await db.pool.query('DROP EXTENSION IF EXISTS pg_trgm');
    // Separate pools (sessions) and no migrations lock: the race other tools could cause.
    const pools = [1, 2, 3, 4].map(() => createPool(db.url, log, { max: 1 }));
    try {
      await Promise.all(pools.map((p) => ensureExtensions(p, log)));
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
    const { rowCount } = await db.pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'",
    );
    expect(rowCount).toBe(1);
  });

  it('explains what an administrator must run when the user cannot create it', async () => {
    await db.pool.query('DROP EXTENSION IF EXISTS pg_trgm');
    const role = `limited_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(12).toString('hex');
    await withAdmin(async (c) => {
      await c.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await c.query(`GRANT CONNECT ON DATABASE ${db.name} TO ${role}`);
    });
    const url = new URL(db.url);
    url.username = role;
    url.password = password;
    const limited = createPool(url.toString(), log, { max: 1 });
    try {
      await expect(ensureExtensions(limited, log)).rejects.toThrow(
        `The PostgreSQL extension pg_trgm is not installed and the database user is not allowed to create it. Ask a database administrator to run this in database "${db.name}": CREATE EXTENSION pg_trgm;`,
      );
    } finally {
      await limited.end();
      await withAdmin(async (c) => {
        await c.query(`REVOKE CONNECT ON DATABASE ${db.name} FROM ${role}`);
        await c.query(`DROP ROLE ${role}`);
      });
    }
  });

  it('reports an extension the server does not have', async () => {
    await expect(ensureExtensions(db.pool, log, ['surface_no_such_extension'])).rejects.toThrow(
      /^The PostgreSQL extension surface_no_such_extension is not available on this server/,
    );
  });
});
