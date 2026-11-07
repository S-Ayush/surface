// PLAN-001 S3 leak test (permissions.md §5; not held, plans README §6): a session's actor comes from
// the real `pgAuthStore` query, so private-team groups must follow membership. A user outside
// private team SEC, an Admin outside it included, gets no `team:SEC` group and none of SEC's rows
// in a bootstrap made with their real session cookie; SEC's member gets both.
import { randomUUID } from 'node:crypto';
import { decodeBootstrapFrame, NdjsonDecoder, type BootstrapFrame } from '@surface/sync-protocol';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSession, SESSION_COOKIE } from '../src/auth/session.js';
import { SessionAuth } from '../src/auth/sessions.js';
import { pgAuthStore } from '../src/auth/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { syncRegistry } from '../src/sync/registry.js';
import { syncRepo } from '../src/sync/repo.js';
import { FakeAttempts } from './auth-fakes.js';
import { executorHarness, type ExecutorHarness } from './executor.js';
import { captureLogs, testConfig } from './helpers.js';

type Row = Extract<BootstrapFrame, { t: 'row' }>;

let h: ExecutorHarness;
let app: FastifyInstance;
const registry = syncRegistry({ includeFixtures: false });
const users = {
  ana: { id: randomUUID(), role: 'member' }, // member of ENG only
  sam: { id: randomUUID(), role: 'member' }, // member of SEC
  ada: { id: randomUUID(), role: 'admin' }, // Admin, member of no team
} as const;
const cookies: Partial<Record<keyof typeof users, string>> = {};

beforeAll(async () => {
  h = await executorHarness();
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    await repo.insert('Workspace', { id: randomUUID(), name: 'Acme', syncGroups: [] });
    for (const [name, { id, role }] of Object.entries(users)) {
      await repo.insert('User', {
        id,
        email: `${name}@example.com`,
        name,
        displayName: name,
        role,
        syncGroups: [],
      });
    }
    const member = (teamId: string, userId: string) =>
      repo.insert('TeamMembership', { id: randomUUID(), teamId, userId, syncGroups: [] });
    await member(h.teams.eng, users.ana.id);
    await member(h.teams.sec, users.sam.id);
    await repo.flush({});
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  for (const [name, { id }] of Object.entries(users)) {
    const session = await createSession(h.pool, {
      userId: id,
      userAgent: undefined,
      ip: undefined,
      now: new Date(),
    });
    cookies[name as keyof typeof users] = `${SESSION_COOKIE}=${session.token}`;
  }

  const config = testConfig();
  const lifecycle = new Lifecycle();
  const store = pgAuthStore(h.pool);
  const sessions = new SessionAuth(store);
  app = await buildApp({
    config,
    lifecycle,
    logger: createLogger(config, captureLogs().stream),
    sync: {
      pool: h.pool,
      registry,
      resolveActor: sessions.resolveActor,
      sessionIdOf: sessions.sessionIdOf,
    },
    auth: { auth: sessions, store, attempts: new FakeAttempts() },
  });
  // The actor's groups, as the server resolves them for this request.
  app.get('/api/test-groups', async (request) => (await sessions.resolveActor(request))?.groups);
  lifecycle.markReady();
});
afterAll(async () => {
  await app.close();
  await h.close();
});

async function groupsOf(name: keyof typeof users): Promise<string[]> {
  const res = await app.inject({ url: '/api/test-groups', headers: { cookie: cookies[name] } });
  expect(res.statusCode).toBe(200);
  return res.json<string[]>();
}

async function bootstrapRows(name: keyof typeof users): Promise<Row[]> {
  const res = await app.inject({ url: '/sync/bootstrap', headers: { cookie: cookies[name] } });
  expect(res.statusCode).toBe(200);
  const decoder = new NdjsonDecoder();
  return [...decoder.push(new Uint8Array(res.rawPayload)), ...decoder.end()]
    .map(decodeBootstrapFrame)
    .filter((f): f is Row => f.t === 'row');
}

const mentionsSec = (rows: readonly Row[]) =>
  rows.some((r) => JSON.stringify(r.d).includes(h.teams.sec));

describe('a session’s groups come from its own memberships', () => {
  it('gives a member of public team ENG no private-team group, and no SEC rows', async () => {
    expect((await groupsOf('ana')).sort()).toEqual(['workspace', `user:${users.ana.id}`].sort());
    const rows = await bootstrapRows('ana');
    expect(rows.length).toBeGreaterThan(0);
    expect(mentionsSec(rows)).toBe(false);
  });

  it('gives an Admin outside SEC no SEC group or rows (Admins see private teams only as members)', async () => {
    expect(await groupsOf('ada')).not.toContain(`team:${h.teams.sec}`);
    expect(mentionsSec(await bootstrapRows('ada'))).toBe(false);
  });

  it('gives SEC’s member the SEC group and SEC’s rows', async () => {
    expect(await groupsOf('sam')).toContain(`team:${h.teams.sec}`);
    const rows = await bootstrapRows('sam');
    expect(rows.some((r) => r.m === 'Team' && r.d.id === h.teams.sec)).toBe(true);
  });
});
