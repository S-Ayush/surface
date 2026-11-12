// `@surface/server/testing` (PLAN-002 S9 part 2): the real server the sync simulation runs
// against. Part of the sync property suite, which the testing hold exempts (SPEC-002 D1).
import { randomUUID } from 'node:crypto';
import {
  BOOTSTRAP_PATH,
  CSRF_INVALID,
  bootstrapMetaSchema,
  encodeBootstrapQuery,
} from '@surface/sync-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './db.js';
import { startTestServer, type TestServer, type TestUser } from './support/testing.js';

let db: TestDatabase | undefined;
let server: TestServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  await db?.drop();
  db = undefined;
});

async function start(users: number): Promise<TestServer> {
  db = await createTestDatabase();
  server = await startTestServer({ databaseUrl: db.url, users });
  return server;
}

async function bootstrapMeta(s: TestServer, user: TestUser) {
  const query = encodeBootstrapQuery({ userId: user.id });
  const response = await fetch(`${s.url}${BOOTSTRAP_PATH}?${query}`, {
    headers: { cookie: user.cookie },
  });
  expect(response.status).toBe(200);
  const [first] = (await response.text()).split('\n');
  return bootstrapMetaSchema.parse(JSON.parse(first ?? ''));
}

describe('the real server for the sync simulation', () => {
  it('signs in every user, who can each run debug operations and bootstrap the fixtures', async () => {
    const s = await start(3);
    expect(s.users.map((u) => u.email)).toEqual([
      'sim-0@example.com',
      'sim-1@example.com',
      'sim-2@example.com',
    ]);
    const before = await s.head();
    const id = randomUUID();
    const created = await s.run(s.users[1] ?? expect.fail('user 1'), 'debug.create', {
      id,
      title: 'First item',
    });
    expect(created.ok).toBe(true);
    const touched = await s.run(s.users[2] ?? expect.fail('user 2'), 'debug.touch', { id });
    expect(touched.ok).toBe(true);
    expect(await s.items()).toEqual([
      { id, title: 'First item', counter: 1, archived: false, syncGroups: ['workspace'] },
    ]);
    expect(await s.head()).toBeGreaterThan(before);
    for (const user of s.users) {
      // The engine fixtures are in the hash the client must match (SPEC-002 Q8).
      expect((await bootstrapMeta(s, user)).schemaHash).toBe(s.schemaHash);
    }
  });

  it('checks CSRF like for any client: a POST without the token is refused', async () => {
    const s = await start(1);
    const user = s.users[0] ?? expect.fail('user 0');
    const response = await fetch(`${s.url}/api/ops/debug.echo`, {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { message: 'hi' } }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: CSRF_INVALID } });
  });

  it('keeps rows and sessions across a restart, on a new port if need be', async () => {
    const s = await start(2);
    const id = randomUUID();
    const [admin, other] = s.users;
    if (admin === undefined || other === undefined) expect.fail('two users');
    expect((await s.run(admin, 'debug.create', { id, title: 'Survives' })).ok).toBe(true);
    const head = await s.head();
    await s.restart();
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await s.head()).toBe(head);
    expect((await s.run(other, 'debug.touch', { id })).ok).toBe(true);
    expect((await s.items())[0]).toMatchObject({ id, counter: 1 });
  });

  it('compacts the log down to its newest row, as retention does', async () => {
    const s = await start(1);
    const user = s.users[0] ?? expect.fail('user 0');
    for (const title of ['One', 'Two']) {
      expect((await s.run(user, 'debug.create', { id: randomUUID(), title })).ok).toBe(true);
    }
    const head = await s.head();
    await s.compactLog();
    const pool = db?.pool ?? expect.fail('no database');
    const { rows } = await pool.query<{ ids: string[] }>(
      'SELECT array_agg(sync_id::text) AS ids FROM sync_log',
    );
    expect(rows[0]?.ids).toEqual([String(head)]);
    expect(await s.head()).toBe(head);
  });

  it('says so when the database was already set up, instead of failing obscurely', async () => {
    const s = await start(1);
    await s.stop();
    server = undefined;
    const url = db?.url ?? expect.fail('no database');
    await expect(startTestServer({ databaseUrl: url })).rejects.toThrow(
      'This database is already set up. Pass a fresh one, such as createTestDatabase().',
    );
  });

  it('may be stopped twice, and stopping releases the database', async () => {
    const s = await start(1);
    await s.stop();
    await s.stop();
    server = undefined;
    // `drop()` in afterEach waits for every connection to the database to close.
  });
});
