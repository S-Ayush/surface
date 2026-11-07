// PLAN-001 S1 leak test (permissions.md §5 items 1–2, SPEC-002 AC-11 bootstrap part, for the
// workspace and team models): a user outside private team SEC gets none of SEC's team,
// statuses, labels or memberships, nor another user's preferences, and a password hash reaches
// neither a client nor `sync_log`. Not held: a private-team leak test (plans README §6).
import { randomUUID } from 'node:crypto';
import { decodeBootstrapFrame, NdjsonDecoder, type BootstrapFrame } from '@surface/sync-protocol';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { syncRegistry } from '../src/sync/registry.js';
import { syncRepo } from '../src/sync/repo.js';
import { executorHarness, type ExecutorHarness } from './executor.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';

type Row = Extract<BootstrapFrame, { t: 'row' }>;

let h: ExecutorHarness;
let app: FastifyInstance;
const registry = syncRegistry({ includeFixtures: false });

const SECRET = 'argon2id$v=19$m=19456,t=2,p=1$not-a-real-hash';
const ana = randomUUID(); // member of ENG only
const sam = randomUUID(); // member of SEC
const ids = {
  engLabel: randomUUID(),
  secLabel: randomUUID(),
  bugLabel: randomUUID(),
  anaInEng: randomUUID(),
  samInSec: randomUUID(),
};

beforeAll(async () => {
  h = await executorHarness();
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    for (const [id, name] of [
      [ana, 'Ana'],
      [sam, 'Sam'],
    ] as const) {
      await repo.insert('User', {
        id,
        email: `${name.toLowerCase()}@example.com`,
        name,
        displayName: name.toLowerCase(),
        syncGroups: [],
      });
      // Server-only: plain SQL, like the auth handlers will (PLAN-001 S3).
      await client.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [
        id,
        SECRET,
      ]);
      await repo.insert('UserPreferences', { id, values: { theme: 'dark' }, syncGroups: [] });
    }
    const label = (id: string, teamId: string | null, name: string) =>
      repo.insert('Label', { id, teamId, name, color: 'red', syncGroups: [] });
    await label(ids.engLabel, h.teams.eng, 'Backend');
    await label(ids.secLabel, h.teams.sec, 'Incident');
    await label(ids.bugLabel, null, 'Bug');
    const member = (id: string, teamId: string, userId: string) =>
      repo.insert('TeamMembership', { id, teamId, userId, syncGroups: [] });
    await member(ids.anaInEng, h.teams.eng, ana);
    await member(ids.samInSec, h.teams.sec, sam);
    await repo.flush({});
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const config = testConfig();
  const lifecycle = new Lifecycle();
  app = await buildApp({
    config,
    lifecycle,
    logger: createLogger(config, captureLogs().stream),
    sync: {
      pool: h.pool,
      registry,
      resolveActor: headerActor({
        ana: actorFor({ id: ana, memberships: [{ teamId: h.teams.eng, private: false }] }),
        sam: actorFor({ id: sam, memberships: [{ teamId: h.teams.sec, private: true }] }),
      }),
    },
  });
  lifecycle.markReady();
});
afterAll(async () => {
  await app.close();
  await h.close();
});

async function bootstrapRows(actor: string): Promise<Row[]> {
  const res = await app.inject({ url: '/sync/bootstrap', headers: { 'x-test-actor': actor } });
  expect(res.statusCode).toBe(200);
  const decoder = new NdjsonDecoder();
  return [...decoder.push(new Uint8Array(res.rawPayload)), ...decoder.end()]
    .map(decodeBootstrapFrame)
    .filter((f): f is Row => f.t === 'row');
}

const idsOf = (rows: readonly Row[], model: string) =>
  rows
    .filter((r) => r.m === model)
    .map((r) => r.d.id)
    .sort();

/** Every row that belongs to `teamId`: the team, and rows with that `teamId`. */
const rowsOfTeam = (rows: readonly Row[], teamId: string) =>
  rows.filter((r) => (r.m === 'Team' ? r.d.id === teamId : r.d['teamId'] === teamId));

describe('bootstrap for a user outside private team SEC', () => {
  it('contains none of SEC’s team, statuses, labels or memberships', async () => {
    const rows = await bootstrapRows('ana');
    expect(rowsOfTeam(rows, h.teams.sec)).toEqual([]);
    expect(rows.some((r) => JSON.stringify(r.d).includes(h.teams.sec))).toBe(false);
  });

  it('contains public team ENG with its 8 statuses, its label and the workspace label', async () => {
    const rows = await bootstrapRows('ana');
    expect(idsOf(rows, 'Team')).toEqual([h.teams.eng]);
    expect(rows.filter((r) => r.m === 'WorkflowStatus')).toHaveLength(8);
    expect(idsOf(rows, 'Label')).toEqual([ids.engLabel, ids.bugLabel].sort());
    expect(idsOf(rows, 'TeamMembership')).toEqual([ids.anaInEng]);
  });

  it('contains only its own preferences', async () => {
    expect(idsOf(await bootstrapRows('ana'), 'UserPreferences')).toEqual([ana]);
  });
});

describe('bootstrap for a member of private team SEC', () => {
  it('contains SEC’s rows, each with SEC’s group', async () => {
    const rows = rowsOfTeam(await bootstrapRows('sam'), h.teams.sec);
    // The team, 8 statuses, a label and a membership.
    expect(rows).toHaveLength(11);
    for (const row of rows) expect(row.d['groups']).toEqual([`team:${h.teams.sec}`]);
  });
});

describe('a password hash', () => {
  it('reaches no bootstrap row', async () => {
    for (const actor of ['ana', 'sam']) {
      expect(JSON.stringify(await bootstrapRows(actor))).not.toContain(SECRET);
    }
  });

  it('is never stored in sync_log', async () => {
    const { rows } = await h.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM sync_log WHERE data::text LIKE $1',
      [`%${SECRET}%`],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe('bootstrap rows', () => {
  it('match the client models', async () => {
    for (const row of await bootstrapRows('sam')) {
      const model = registry.models.find((m) => m.name === row.m);
      expect(model?.def.rowSchema.parse(row.d)).toEqual(row.d);
    }
  });
});
