// PLAN-010 S2 leak test (SPEC-010 AC-15, permissions.md §5, CLAUDE.md rule 4; not held, plans
// README §6): every status operation naming private team SEC, from a non-member Member or Admin,
// answers exactly like a team that doesn't exist, by key and by id, and writes nothing; a status
// of SEC named by id or name is as unknown as a status that never existed; `status.list` never
// returns SEC's statuses, even when a filter asks for them.
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
let secStatusId = '';

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
    for (const [teamId, userId] of [
      [h.teams.eng, ana],
      [h.teams.sec, sam],
    ] as const) {
      await repo.insert('TeamMembership', { id: randomUUID(), teamId, userId, syncGroups: [] });
    }
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
  const { rows } = await h.pool.query<{ id: string }>(
    `SELECT id FROM workflow_statuses WHERE team_id = $1 AND name = 'In Review'`,
    [h.teams.sec],
  );
  secStatusId = rows[0]?.id ?? '';
  expect(secStatusId).not.toBe('');
});
afterAll(async () => {
  await h.close();
});

async function logLength(): Promise<number> {
  const { rows } = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM sync_log');
  return rows[0]?.n ?? 0;
}

async function statusCount(): Promise<number> {
  const { rows } = await h.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM workflow_statuses',
  );
  return rows[0]?.n ?? 0;
}

/** The failure of `operation`, with the given words replaced, so two answers can be compared. */
async function failure(operation: string, input: object, actor: Actor, hidden: string[]) {
  const result = await executor.execute(operation, input, actor);
  if (result.ok) return { ok: true };
  const hide = (text: string) => hidden.reduce((t, word) => t.replaceAll(word, '<ref>'), text);
  const { code, message, issues } = result.error;
  return {
    code,
    message: hide(message),
    issues: (issues ?? []).map((issue) => ({ ...issue, message: hide(issue.message) })),
  };
}

type Call = (team: string) => [string, object];
const CALLS: Record<string, Call> = {
  'status.list': (team) => ['status.list', { team }],
  'status.create': (team) => ['status.create', { team, name: 'Leak', category: 'started' }],
  'status.update': (team) => ['status.update', { team, status: 'In Review', name: 'Leaked' }],
  'status.reorder': (team) => [
    'status.reorder',
    { team, status: 'In Review', before: 'In Progress' },
  ],
  'status.delete': (team) => ['status.delete', { team, status: 'In Review' }],
};

describe('a non-member naming private team SEC', () => {
  for (const [who, actor] of [
    ['a Member', () => anaActor],
    ['an Admin', () => zoeActor],
  ] as const) {
    for (const [name, call] of Object.entries(CALLS)) {
      it(`${name} answers ${who} like an unknown team, by key and by id, and writes nothing`, async () => {
        const before = { log: await logLength(), statuses: await statusCount() };
        for (const [secRef, unknownRef] of [
          ['SEC', 'ZZZ'],
          [h.teams.sec, randomUUID()],
        ] as const) {
          const real = await failure(...call(secRef), actor(), [secRef]);
          const unknown = await failure(...call(unknownRef), actor(), [unknownRef]);
          expect(real).toEqual(unknown);
          expect(real).toMatchObject({ code: 'NOT_FOUND' });
        }
        expect(await logLength()).toBe(before.log);
        expect(await statusCount()).toBe(before.statuses);
      });
    }

    it(`answers ${who} naming a SEC status through ENG like a status that never existed`, async () => {
      for (const operation of ['status.update', 'status.delete'] as const) {
        const input = (status: string) =>
          operation === 'status.update'
            ? { team: 'ENG', status, name: 'Leaked' }
            : { team: 'ENG', status };
        const unknownId = randomUUID();
        const real = await failure(operation, input(secStatusId), actor(), [secStatusId]);
        const unknown = await failure(operation, input(unknownId), actor(), [unknownId]);
        expect(real).toMatchObject({ code: 'NOT_FOUND' });
        expect(real).toEqual(unknown);
      }
    });

    it(`never lists SEC's statuses to ${who}, even when a filter asks for them`, async () => {
      const result = await executor.execute(
        'status.list',
        { team: 'ENG', filter: { field: 'teamId', op: 'eq', value: h.teams.sec } },
        actor(),
      );
      expect(result).toMatchObject({ ok: true, result: { nodes: [] } });
      const all = await executor.execute('status.list', { team: 'ENG', limit: 100 }, actor());
      expect(JSON.stringify(all)).not.toContain(secStatusId);
    });
  }
});

describe('a member of private team SEC', () => {
  // The control: the same calls succeed for someone who can see SEC, so the answers above come
  // from visibility, not from a broken operation.
  it('lists, adds, renames, reorders and deletes SEC statuses, by key and by id', async () => {
    const listed = await executor.execute('status.list', { team: 'SEC' }, samActor);
    expect(listed).toMatchObject({ ok: true });
    expect(JSON.stringify(listed)).toContain(secStatusId);
    const created = await executor.execute(
      'status.create',
      { team: h.teams.sec, name: 'Blocked', category: 'started' },
      samActor,
    );
    expect(created).toMatchObject({ ok: true, result: { name: 'Blocked', teamId: h.teams.sec } });
    for (const [operation, input] of [
      ['status.update', { team: 'SEC', status: 'Blocked', name: 'Waiting' }],
      ['status.reorder', { team: 'SEC', status: 'Waiting', before: 'In Progress' }],
      ['status.delete', { team: h.teams.sec, status: 'Waiting' }],
    ] as const) {
      expect(await executor.execute(operation, input, samActor)).toMatchObject({ ok: true });
    }
  });

  it('writes sync_log rows in the private group only', async () => {
    const { rows } = await h.pool.query<{ groups: string[] }>(
      `SELECT groups FROM sync_log WHERE model = 'WorkflowStatus' ORDER BY sync_id DESC LIMIT 3`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.groups).toEqual([`team:${h.teams.sec}`]);
  });
});
