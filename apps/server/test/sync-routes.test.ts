// PLAN-002 S3: who may bootstrap, and SPEC-002 E14: for whose replica. These answers come before
// any database work, so the pool here never connects. What a bootstrap contains is
// `sync-groups.int.test.ts` (AC-11).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { syncRegistry } from '../src/sync/registry.js';
import { acceptsGzip } from '../src/sync/routes.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';

const member = actorFor({ id: randomUUID() });
const apiKey = actorFor(
  { id: randomUUID() },
  {
    kind: 'api',
    apiKey: { id: randomUUID(), scope: 'read', teamIds: [randomUUID()], allowDestructive: false },
  },
);

let pool: pg.Pool | undefined;
afterEach(async () => {
  await pool?.end();
  pool = undefined;
});

async function app({ ready = true } = {}) {
  const config = testConfig();
  const lifecycle = new Lifecycle();
  pool = new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/unused' });
  const built = await buildApp({
    config,
    lifecycle,
    logger: createLogger(config, captureLogs().stream),
    sync: {
      pool,
      registry: syncRegistry({ includeFixtures: true }),
      resolveActor: headerActor({ member, apiKey }),
    },
  });
  if (ready) lifecycle.markReady();
  return built;
}

describe('GET /sync/bootstrap refuses', () => {
  it('nobody signed in, with 401', async () => {
    const res = await (await app()).inject({ url: '/sync/bootstrap' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('while the server is starting, with 503 and Retry-After', async () => {
    const res = await (
      await app({ ready: false })
    ).inject({
      url: '/sync/bootstrap',
      headers: { 'x-test-actor': 'member' },
    });
    expect([res.statusCode, res.headers['retry-after']]).toEqual([503, '5']);
  });

  it('an API key, whose team limits are not sync groups, with 403', async () => {
    const res = await (
      await app()
    ).inject({
      url: '/sync/bootstrap',
      headers: { 'x-test-actor': 'apiKey' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: 'FORBIDDEN', message: 'Sync is for signed-in users. Use the operations API.' },
    });
  });

  it('a partial bootstrap (?groups=), which arrives with private teams in M7, with 400', async () => {
    const res = await (
      await app()
    ).inject({
      url: `/sync/bootstrap?userId=${member.userId ?? ''}&groups=team:x`,
      headers: { 'x-test-actor': 'member' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('another user’s replica, with 401, before anything is streamed (SPEC-002 E14)', async () => {
    const res = await (
      await app()
    ).inject({
      url: `/sync/bootstrap?userId=${randomUUID()}`,
      headers: { 'x-test-actor': 'member' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('a client without userId (before v0.5), with 426 CLIENT_OUTDATED', async () => {
    const built = await app();
    const missing = await built.inject({
      url: '/sync/bootstrap',
      headers: { 'x-test-actor': 'member' },
    });
    expect(missing.statusCode).toBe(426);
    expect(missing.json()).toMatchObject({ ok: false, error: { code: 'CLIENT_OUTDATED' } });
    // There but not a user id: invalid, not old.
    const invalid = await built.inject({
      url: '/sync/bootstrap?userId=ada',
      headers: { 'x-test-actor': 'member' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('gzip negotiation', () => {
  it.each([
    ['gzip, deflate, br', true],
    ['br;q=1.0, gzip;q=0.5', true],
    ['GZIP', true],
    ['gzip;q=0', false],
    ['deflate', false],
    [undefined, false],
    ['x-gzip', false],
  ])('Accept-Encoding %s → %s', (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected);
  });
});
