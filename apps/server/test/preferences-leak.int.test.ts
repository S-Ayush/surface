// PLAN-005 S7 leak test (permissions.md §5, CLAUDE.md rule 4; not held, plans README §6):
// `user.updatePreferences` with private team SEC as the home team, from a non-member Member or
// Admin, answers exactly like a team that doesn't exist, by key or by id, and writes nothing.
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Executor } from '../src/executor/execute.js';
import { syncRepo } from '../src/sync/repo.js';
import { executorHarness, testExecutor, type ExecutorHarness } from './executor.js';
import { actorFor } from './helpers.js';

let h: ExecutorHarness;
let executor: Executor;
const ana = randomUUID(); // member of ENG only
const sam = randomUUID(); // the only member of private SEC
const zoe = randomUUID(); // an Admin, member of ENG only
let anaActor: Actor;
let samActor: Actor;
let zoeActor: Actor;

beforeAll(async () => {
  h = await executorHarness();
  executor = testExecutor(h.pool).executor;
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    for (const [id, name] of [
      [ana, 'ana'],
      [sam, 'sam'],
      [zoe, 'zoe'],
    ] as const) {
      await repo.insert('User', {
        id,
        email: `${name}@example.com`,
        name,
        displayName: name,
        syncGroups: [],
      });
    }
    await repo.insert('TeamMembership', {
      id: randomUUID(),
      teamId: h.teams.eng,
      userId: ana,
      syncGroups: [],
    });
    await repo.insert('TeamMembership', {
      id: randomUUID(),
      teamId: h.teams.sec,
      userId: sam,
      syncGroups: [],
    });
    await repo.flush({});
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  anaActor = actorFor({ id: ana, memberships: [{ teamId: h.teams.eng, private: false }] });
  samActor = actorFor({ id: sam, memberships: [{ teamId: h.teams.sec, private: true }] });
  zoeActor = actorFor({
    id: zoe,
    role: 'admin',
    memberships: [{ teamId: h.teams.eng, private: false }],
  });
  // Each starts with a saved home team, so "writes nothing" also means it is kept.
  for (const actor of [anaActor, zoeActor]) {
    const saved = await executor.execute('user.updatePreferences', { homeTeam: 'ENG' }, actor);
    expect(saved).toMatchObject({ ok: true, result: { homeTeamId: h.teams.eng } });
  }
});
afterAll(async () => {
  await h.close();
});

async function logLength(): Promise<number> {
  const { rows } = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM sync_log');
  return rows[0]?.n ?? 0;
}

async function savedValues(userId: string): Promise<unknown> {
  const { rows } = await h.pool.query<{ values: unknown }>(
    'SELECT "values" FROM user_preferences WHERE id = $1',
    [userId],
  );
  return rows[0]?.values;
}

/** The failure, with the team reference replaced, so two answers can be compared. */
async function failure(homeTeam: string, actor: Actor) {
  const result = await executor.execute('user.updatePreferences', { homeTeam }, actor);
  if (result.ok) return { ok: true };
  const { code, message, issues } = result.error;
  const hide = (text: string) => text.replaceAll(homeTeam, '<team>');
  return {
    code,
    message: hide(message),
    issues: (issues ?? []).map((issue) => ({ ...issue, message: hide(issue.message) })),
  };
}

describe('a non-member making private team SEC their home view', () => {
  for (const [who, actor] of [
    ['a Member', () => anaActor],
    ['an Admin', () => zoeActor],
  ] as const) {
    it(`answers ${who} like an unknown team, by key and by id, and writes nothing`, async () => {
      const userId = actor().userId ?? '';
      const before = { log: await logLength(), values: await savedValues(userId) };

      const byKey = await failure('SEC', actor());
      expect(byKey).toEqual(await failure('ZZZ', actor()));
      expect(byKey).toMatchObject({ code: 'NOT_FOUND' });
      const byId = await failure(h.teams.sec, actor());
      expect(byId).toEqual(await failure(randomUUID(), actor()));
      expect(byId).toMatchObject({ code: 'NOT_FOUND' });

      expect(await logLength()).toBe(before.log);
      expect(await savedValues(userId)).toEqual(before.values);
    });
  }
});

describe('a member of private team SEC', () => {
  // The control: the same call succeeds for someone who can see SEC, so the answers above come
  // from visibility, not from a broken operation.
  it('can make SEC their home view, by key and by id', async () => {
    for (const homeTeam of ['SEC', h.teams.sec]) {
      const result = await executor.execute('user.updatePreferences', { homeTeam }, samActor);
      expect(result).toMatchObject({ ok: true, result: { homeTeamId: h.teams.sec } });
    }
  });
});
