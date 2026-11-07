// PLAN-001 S8 leak test (permissions.md §5, CLAUDE.md rule 4; not held, plans README §6): every
// team operation a non-member, Member or Admin, aims at private team SEC answers exactly like one
// aimed at a team that doesn't exist, by key or by id, and writes nothing. A taken key is the one thing a
// non-member learns (keys are unique workspace-wide, INV-03): never the team's name or id.
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
});
afterAll(async () => {
  await h.close();
});

async function logLength(): Promise<number> {
  const { rows } = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM sync_log');
  return rows[0]?.n ?? 0;
}

/** The failure, with the team reference replaced, so two answers can be compared. */
async function failure(op: string, input: Record<string, unknown>, actor: Actor) {
  const result = await executor.execute(op, input, actor);
  if (result.ok) return { ok: true };
  const team = String(input['team']);
  const { code, message, issues } = result.error;
  const hide = (text: string) => text.replaceAll(team, '<team>');
  return {
    code,
    message: hide(message),
    issues: (issues ?? []).map((issue) => ({ ...issue, message: hide(issue.message) })),
  };
}

const OPS: readonly [string, Record<string, unknown>][] = [
  ['team.update', { name: 'Renamed', color: 'red' }],
  ['team.join', {}],
  ['team.leave', {}],
  ['team.addMember', { user: 'me' }],
  ['team.removeMember', { user: 'sam@example.com' }],
];

describe('a non-member aiming a team operation at private team SEC', () => {
  const actors = () =>
    [
      ['a Member', anaActor],
      ['an Admin', zoeActor],
    ] as const;
  for (const [op, rest] of OPS) {
    it(`${op} answers like an unknown team, by key and by id, and writes nothing`, async () => {
      for (const [who, actor] of actors()) {
        const before = await logLength();
        const byKey = await failure(op, { team: 'SEC', ...rest }, actor);
        expect(byKey, who).toEqual(await failure(op, { team: 'ZZZ', ...rest }, actor));
        expect(byKey, who).toMatchObject({ code: 'NOT_FOUND' });
        const byId = await failure(op, { team: h.teams.sec, ...rest }, actor);
        expect(byId, who).toEqual(await failure(op, { team: randomUUID(), ...rest }, actor));
        expect(await logLength(), who).toBe(before);
      }
    });
  }

  it('learns from team.create only that the key is taken, never the team’s name or id', async () => {
    const result = await executor.execute(
      'team.create',
      { name: 'Secret Squad', key: 'SEC' },
      anaActor,
    );
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).toContain('Team key SEC is taken');
    expect(text).not.toContain('Security');
    expect(text).not.toContain(h.teams.sec);
  });

  it('is never suggested SEC’s key', async () => {
    const result = await executor.execute('team.suggestKey', { name: 'Security' }, anaActor);
    expect(result).toMatchObject({ ok: true, result: { key: 'SECU' } });
  });
});

describe('a member of private team SEC', () => {
  // The control: the same calls succeed for someone who can see SEC, so the answers above come
  // from visibility, not from a broken operation.
  it('can update SEC and add a member to it', async () => {
    const update = await executor.execute(
      'team.update',
      { team: 'SEC', name: 'Sec ops' },
      samActor,
    );
    expect(update).toMatchObject({
      ok: true,
      result: { key: 'SEC', name: 'Sec ops', private: true },
    });
    const add = await executor.execute('team.addMember', { team: 'SEC', user: 'ana' }, samActor);
    expect(add).toMatchObject({ ok: true, result: { teamKey: 'SEC', userId: ana, member: true } });
  });
});
