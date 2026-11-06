// SPEC-004 §8 step 2 / E1: wait for the database, retrying transient failures only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, waitForDatabase } from '../src/db/pool.js';
import { StartupError } from '../src/startup-error.js';
import { captureLogs, freePort } from './helpers.js';
import { createTestDatabase, silentLog as log, type TestDatabase } from './db.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ migrated: false });
});
afterAll(async () => {
  await db.drop();
});

async function attempt(url: string, timeoutMs: number) {
  const logs = captureLogs();
  const { pino } = await import('pino');
  const logger = pino({ level: 'info' }, logs.stream);
  const pool = createPool(url, log, { max: 1 });
  const started = performance.now();
  try {
    await waitForDatabase(pool, { log: logger, databaseUrl: url, timeoutMs, intervalMs: 100 });
    return { error: undefined, elapsed: performance.now() - started, logs };
  } catch (error) {
    return { error: error as Error, elapsed: performance.now() - started, logs };
  } finally {
    await pool.end();
  }
}

describe('waitForDatabase', () => {
  it('returns once the database answers', async () => {
    expect((await attempt(db.url, 5_000)).error).toBeUndefined();
  });

  it('retries an unreachable database until the deadline, then gives an actionable error (E1)', async () => {
    const url = `postgres://surface:hunter2@127.0.0.1:${await freePort()}/surface`;
    const { error, elapsed, logs } = await attempt(url, 1_000);

    expect(error).toBeInstanceOf(StartupError);
    expect(error?.message).toMatch(
      /^Could not reach the database at 127\.0\.0\.1:\d+\/surface after 1 s \(ECONNREFUSED/,
    );
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(5_000);
    expect(logs.lines.some((l) => l.msg === 'waiting for database…')).toBe(true);
    expect(`${error?.message} ${logs.text()}`).not.toContain('hunter2');
  });

  it('fails fast on wrong credentials without echoing the password', async () => {
    const url = new URL(db.url);
    url.password = 'definitely-wrong-password';
    const { error, elapsed } = await attempt(url.toString(), 10_000);

    expect(error).toBeInstanceOf(StartupError);
    expect(error?.message).toMatch(/^The database rejected the username or password/);
    // The server's own reason is included, so operators can tell the cases apart.
    expect(error?.message).toContain('28P01: password authentication failed for user');
    expect(error?.message).not.toContain('definitely-wrong-password');
    expect(elapsed).toBeLessThan(2_000);
  });

  it('fails fast when the database does not exist', async () => {
    const url = new URL(db.url);
    url.pathname = '/no_such_database';
    const { error, elapsed } = await attempt(url.toString(), 10_000);
    expect(error?.message).toMatch(/^The database named in DATABASE_URL does not exist/);
    expect(error?.message).toContain('3D000: database "no_such_database" does not exist');
    expect(elapsed).toBeLessThan(2_000);
  });
});
