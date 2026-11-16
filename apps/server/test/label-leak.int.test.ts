// PLAN-010 S3 leak test (SPEC-010 AC-15, AC-24, permissions.md §5, CLAUDE.md rule 4; not held,
// plans README §6): every label operation naming private team SEC, from a non-member Member or
// Admin, answers exactly like a team that doesn't exist, by key and by id, and writes nothing; a
// SEC label named by id, name or Group/Label through ENG or without a team (update, delete and
// moveToWorkspace) is as unknown as a label that never existed; `label.list` never returns SEC's labels, even when a filter asks for
// them; SEC's label rows are logged to the private group only; and moving a SEC label to the
// workspace logs a `D` for the private group then a `U` for the workspace, so a non-member
// receives only the `U` (a row they never had) and a SEC member sees the row stay.
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/db/uuidv7.js';
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
let secLabelId = '';
let secGroupId = '';

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
  // SEC's labels: a group with one label, made by its only member.
  secGroupId = uuidv7();
  secLabelId = uuidv7();
  for (const input of [
    { id: secGroupId, team: 'SEC', name: 'Severity', isGroup: true },
    { id: secLabelId, team: 'SEC', name: 'Critical', group: 'Severity' },
  ]) {
    const made = await executor.execute('label.create', input, samActor);
    expect(made).toMatchObject({ ok: true });
  }
});
afterAll(async () => {
  await h.close();
});

async function logLength(): Promise<number> {
  const { rows } = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM sync_log');
  return rows[0]?.n ?? 0;
}

async function labelCount(): Promise<number> {
  const { rows } = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM labels');
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
  'label.list': (team) => ['label.list', { team }],
  'label.create': (team) => ['label.create', { team, name: 'Leak' }],
  'label.update': (team) => ['label.update', { team, label: 'Critical', name: 'Leaked' }],
  'label.moveToWorkspace': (team) => ['label.moveToWorkspace', { team, label: 'Severity' }],
  'label.delete': (team) => ['label.delete', { team, label: 'Critical' }],
  'label.archive': (team) => ['label.archive', { team, label: 'Critical' }],
  'label.unarchive': (team) => ['label.unarchive', { team, label: 'Critical' }],
  'label.usage': (team) => ['label.usage', { team }],
};

describe('a non-member naming private team SEC', () => {
  for (const [who, actor] of [
    ['a Member', () => anaActor],
    ['an Admin', () => zoeActor],
  ] as const) {
    for (const [name, call] of Object.entries(CALLS)) {
      it(`${name} answers ${who} like an unknown team, by key and by id, and writes nothing`, async () => {
        const before = { log: await logLength(), labels: await labelCount() };
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
        expect(await labelCount()).toBe(before.labels);
      });
    }

    it(`answers ${who} naming a SEC label by id, name or Group/Label like one that never existed`, async () => {
      const spellings = [
        [secLabelId, randomUUID()],
        ['Severity/Critical', 'Nothing/Critical'],
        ['Critical', 'Missing'],
      ] as const;
      for (const [secSpelling, unknown] of spellings) {
        for (const operation of [
          'label.update',
          'label.delete',
          'label.moveToWorkspace',
          'label.archive',
          'label.unarchive',
        ] as const) {
          // Through ENG (a public team) and with no team at all (workspace labels only); a move
          // always names its team.
          const teams = operation === 'label.moveToWorkspace' ? ['ENG'] : ['ENG', undefined];
          for (const team of teams) {
            const input = (label: string) => ({
              label,
              ...(team === undefined ? {} : { team }),
              ...(operation === 'label.update' ? { name: 'Leaked' } : {}),
            });
            const real = await failure(operation, input(secSpelling), actor(), [secSpelling]);
            const none = await failure(operation, input(unknown), actor(), [unknown]);
            expect(real, `${operation} ${secSpelling} ${team}`).toMatchObject({
              code: 'NOT_FOUND',
            });
            expect(real).toEqual(none);
          }
        }
      }
    });

    it(`answers ${who} naming a SEC group in label.create like an unknown group`, async () => {
      const input = (group: string) => ({ team: 'ENG', name: 'Sneaky', group });
      const unknownId = randomUUID();
      for (const [secSpelling, unknown] of [
        [secGroupId, unknownId],
        ['Severity', 'Missing'],
      ] as const) {
        const real = await failure('label.create', input(secSpelling), actor(), [secSpelling]);
        const none = await failure('label.create', input(unknown), actor(), [unknown]);
        expect(real).toMatchObject({ code: 'NOT_FOUND' });
        expect(real).toEqual(none);
      }
    });

    it(`never lists SEC's labels to ${who}, even when a filter asks for them`, async () => {
      const asked = await executor.execute(
        'label.list',
        { team: 'ENG', filter: { field: 'teamId', op: 'eq', value: h.teams.sec } },
        actor(),
      );
      expect(asked).toMatchObject({ ok: true, result: { nodes: [] } });
      const byGroup = await executor.execute(
        'label.list',
        { group: secGroupId, includeArchived: true },
        actor(),
      );
      expect(byGroup).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      // By name, as unknown as a group that never existed (with and without a team).
      for (const team of [{ team: 'ENG' }, {}]) {
        const real = await failure('label.list', { ...team, group: 'Severity' }, actor(), [
          'Severity',
        ]);
        const none = await failure('label.list', { ...team, group: 'Missing' }, actor(), [
          'Missing',
        ]);
        expect(real).toMatchObject({ code: 'NOT_FOUND' });
        expect(real).toEqual(none);
      }
      for (const input of [{ limit: 100 }, { scope: 'team', limit: 100 }, { team: 'ENG' }]) {
        const all = await executor.execute('label.list', input, actor());
        expect(all).toMatchObject({ ok: true });
        expect(JSON.stringify(all)).not.toContain(secLabelId);
        expect(JSON.stringify(all)).not.toContain(secGroupId);
      }
    });
  }
});

describe('SEC label rows in the sync log', () => {
  it('are logged to the private group only', async () => {
    const { rows } = await h.pool.query<{ groups: string[] }>(
      `SELECT groups FROM sync_log WHERE model = 'Label' AND model_id = ANY($1::uuid[])`,
      [[secLabelId, secGroupId]],
    );
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.groups).toEqual([`team:${h.teams.sec}`]);
  });
});

describe('a member of private team SEC', () => {
  // The control: the same calls succeed for someone who can see SEC, so the answers above come
  // from visibility, not from a broken operation.
  it('lists, renames and edits SEC labels, by key, id and Group/Label', async () => {
    const listed = await executor.execute('label.list', { team: 'SEC' }, samActor);
    expect(listed).toMatchObject({ ok: true });
    expect(JSON.stringify(listed)).toContain(secLabelId);
    for (const [operation, input] of [
      ['label.update', { team: 'SEC', label: 'Severity/Critical', name: 'Urgent' }],
      ['label.update', { label: secLabelId, name: 'Critical' }],
      ['label.update', { team: 'SEC', label: 'Critical', description: 'Drop everything' }],
    ] as const) {
      expect(await executor.execute(operation, input, samActor), operation).toMatchObject({
        ok: true,
      });
    }
  });

  it('can move a SEC group and its label to the workspace (AC-24)', async () => {
    const last = await h.pool.query<{ id: number }>(
      'SELECT coalesce(max(sync_id), 0)::int AS id FROM sync_log',
    );
    const moved = await executor.execute(
      'label.moveToWorkspace',
      { team: 'SEC', label: 'Severity' },
      samActor,
    );
    expect(moved).toMatchObject({ ok: true, result: { id: secGroupId, teamId: null } });
    const { rows } = await h.pool.query<{
      model_id: string;
      action: string;
      groups: string[];
    }>(
      `SELECT model_id, action, groups FROM sync_log
        WHERE model = 'Label' AND sync_id > $1 ORDER BY sync_id`,
      [last.rows[0]?.id ?? 0],
    );
    // One `D` for the private group, then one `U` for the workspace, per moved label.
    expect(rows).toHaveLength(4);
    for (const id of [secGroupId, secLabelId]) {
      const own = rows.filter((r) => r.model_id === id);
      expect(own.map((r) => r.action)).toEqual(['D', 'U']);
      expect(own[0]?.groups).toEqual([`team:${h.teams.sec}`]);
      expect(own[1]?.groups).toEqual(['workspace']);
    }
  });

  it('now shows the moved labels to a non-member, as workspace labels', async () => {
    for (const actor of [anaActor, zoeActor]) {
      const listed = await executor.execute(
        'label.list',
        { scope: 'workspace', limit: 100 },
        actor,
      );
      expect(JSON.stringify(listed)).toContain(secLabelId);
      const ref = await executor.execute(
        'label.update',
        { label: 'Severity/Critical', description: 'Seen by all' },
        actor,
      );
      expect(ref).toMatchObject({ ok: true });
    }
  });
});

// SPEC-010 §5: a label id resolves to any visible label whatever `team` says, so permission is
// checked on the label's own team. Sam belongs to SEC only; ENG is a public team he can read.
describe('naming a team the actor belongs to for another team’s label by id', () => {
  it('is FORBIDDEN for update and delete, and changes nothing', async () => {
    const id = uuidv7();
    const made = await executor.execute(
      'label.create',
      { id, team: 'ENG', name: 'Public ENG' },
      anaActor,
    );
    expect(made).toMatchObject({ ok: true });
    const before = await logLength();
    for (const [operation, input] of [
      ['label.update', { team: 'SEC', label: id, name: 'Hijacked' }],
      ['label.delete', { team: 'SEC', label: id }],
      ['label.moveToWorkspace', { team: 'SEC', label: id }],
      ['label.archive', { team: 'SEC', label: id }],
      ['label.unarchive', { team: 'SEC', label: id }],
    ] as const) {
      const result = await executor.execute(operation, input, samActor);
      expect(result, operation).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    expect(await logLength()).toBe(before);
    const row = await h.pool.query<{ name: string }>('SELECT name FROM labels WHERE id = $1', [id]);
    expect(row.rows[0]?.name).toBe('Public ENG');
  });
});

// PLAN-010 S6, AC-11 and AC-15: archive and unarchive go through the repo's archive path, so the
// log holds an `A` and a `V` with the full row, in the private team's group only; a group takes
// its labels with it. SEC's first labels were moved to the workspace above, so a fresh private
// group is made here.
describe('archiving a private team’s labels (AC-11, AC-15)', () => {
  const groupId = uuidv7();
  const labelId = uuidv7();

  it('logs one A per archived row to the private group only, and one V per unarchived row', async () => {
    for (const input of [
      { id: groupId, team: 'SEC', name: 'Region', isGroup: true },
      { id: labelId, team: 'SEC', name: 'EU', group: 'Region' },
    ]) {
      expect(await executor.execute('label.create', input, samActor)).toMatchObject({ ok: true });
    }
    const last = await h.pool.query<{ id: number }>(
      'SELECT coalesce(max(sync_id), 0)::int AS id FROM sync_log',
    );
    const since = last.rows[0]?.id ?? 0;
    const archived = await executor.execute(
      'label.archive',
      { team: 'SEC', label: 'Region' },
      samActor,
    );
    expect(archived).toMatchObject({ ok: true, result: { id: groupId } });
    const again = await executor.execute(
      'label.archive',
      { team: 'SEC', label: 'Region' },
      samActor,
    );
    expect(again).toMatchObject({ ok: true });
    const unarchived = await executor.execute(
      'label.unarchive',
      { team: 'SEC', label: 'Region' },
      samActor,
    );
    expect(unarchived).toMatchObject({ ok: true });
    const { rows } = await h.pool.query<{
      model_id: string;
      action: string;
      groups: string[];
      data: { archivedAt: string | null };
    }>(
      `SELECT model_id, action, groups, data FROM sync_log
        WHERE model = 'Label' AND sync_id > $1 ORDER BY sync_id`,
      [since],
    );
    // Archive: A for each of the two rows; the repeat writes nothing; unarchive: V for each.
    expect(rows.map((r) => r.action).sort()).toEqual(['A', 'A', 'V', 'V']);
    for (const row of rows) {
      expect(row.groups).toEqual([`team:${h.teams.sec}`]);
      expect(row.data.archivedAt === null).toBe(row.action === 'V');
    }
  });

  it('refuses a non-member by id, name and Group/Label like a label that never existed, archived or not', async () => {
    expect(
      await executor.execute('label.archive', { team: 'SEC', label: 'EU' }, samActor),
    ).toMatchObject({ ok: true });
    const before = await logLength();
    for (const actor of [anaActor, zoeActor]) {
      for (const operation of ['label.archive', 'label.unarchive'] as const) {
        for (const [real, unknown] of [
          [labelId, randomUUID()],
          ['EU', 'Missing'],
          ['Region/EU', 'Nothing/EU'],
        ] as const) {
          for (const team of [{}, { team: 'ENG' }]) {
            const a = await failure(operation, { ...team, label: real }, actor, [real]);
            const b = await failure(operation, { ...team, label: unknown }, actor, [unknown]);
            expect(a, `${operation} ${real}`).toMatchObject({ code: 'NOT_FOUND' });
            expect(a).toEqual(b);
          }
        }
      }
    }
    expect(await logLength()).toBe(before);
  });

  it('never delivers the archived row to the other groups: its log rows carry the private group only', async () => {
    const { rows } = await h.pool.query<{ groups: string[] }>(
      `SELECT groups FROM sync_log WHERE model = 'Label' AND model_id = $1`,
      [labelId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.groups).toEqual([`team:${h.teams.sec}`]);
  });
});

describe('moving a public team label to the workspace (AC-24)', () => {
  it('logs one U with the full row and no D, because the groups do not change', async () => {
    const id = uuidv7();
    const made = await executor.execute(
      'label.create',
      { id, team: 'ENG', name: 'Shared soon' },
      anaActor,
    );
    expect(made).toMatchObject({ ok: true });
    const last = await h.pool.query<{ id: number }>(
      'SELECT coalesce(max(sync_id), 0)::int AS id FROM sync_log',
    );
    const moved = await executor.execute(
      'label.moveToWorkspace',
      { team: 'ENG', label: 'Shared soon' },
      anaActor,
    );
    expect(moved).toMatchObject({ ok: true, result: { id, teamId: null } });
    const { rows } = await h.pool.query<{ action: string; groups: string[]; data: unknown }>(
      `SELECT action, groups, data FROM sync_log
        WHERE model = 'Label' AND model_id = $1 AND sync_id > $2 ORDER BY sync_id`,
      [id, last.rows[0]?.id ?? 0],
    );
    expect(rows.map((r) => r.action)).toEqual(['U']);
    expect(rows[0]?.groups).toEqual(['workspace']);
    expect(rows[0]?.data).toMatchObject({ teamId: null });
  });
});

// PLAN-010 S5 (SPEC-010 E7, AC-15, AC-26, D15): the issue-dependent halves. Two workspace labels
// and one SEC label sit on an ENG issue and a SEC issue. `label.usage` counts and names only what
// the actor can see; deleting a workspace label rewrites every issue but reports only the visible
// ones; `status.delete` on a SEC status answers like a status that never existed, with no count.
describe('the issue-dependent halves (PLAN-010 S5)', () => {
  const engIssue = uuidv7();
  const secIssue = uuidv7();
  const common = uuidv7();
  const spare = uuidv7();
  // Issues are read through the public teams a session carries (SPEC-011 §5.6), as in production.
  const seeing = (actor: Actor): Actor => ({ ...actor, publicTeams: [h.teams.eng] });

  beforeAll(async () => {
    for (const [input, actor] of [
      [{ id: common, name: 'Common' }, seeing(zoeActor)],
      [{ id: spare, name: 'Spare' }, seeing(zoeActor)],
      [{ team: 'SEC', name: 'Secret' }, seeing(samActor)],
    ] as const) {
      expect(await executor.execute('label.create', input, actor)).toMatchObject({ ok: true });
    }
    for (const [input, actor] of [
      [
        { id: engIssue, team: 'ENG', title: 'Fix login', labels: ['Common', 'Spare'] },
        seeing(anaActor),
      ],
      [
        { id: secIssue, team: 'SEC', title: 'Rotate keys', labels: ['Common', 'Spare', 'Secret'] },
        seeing(samActor),
      ],
    ] as const) {
      expect(await executor.execute('issue.create', input, actor)).toMatchObject({ ok: true });
    }
  });

  type Usage = {
    labels: { label: { name: string }; issues: number; teams: { id: string; key: string }[] }[];
  };
  async function usage(input: object, actor: Actor): Promise<Usage> {
    const result = await executor.execute('label.usage', input, actor);
    if (!result.ok) throw new Error(result.error.message);
    return result.result as Usage;
  }

  for (const [who, actor] of [
    ['a Member', () => seeing(anaActor)],
    ['an Admin', () => seeing(zoeActor)],
  ] as const) {
    it(`label.usage counts and names no SEC issue or team for ${who}`, async () => {
      for (const input of [{}, { scope: 'workspace' }, { team: 'ENG' }]) {
        const answer = await usage(input, actor());
        const text = JSON.stringify(answer);
        expect(text).not.toContain(h.teams.sec);
        expect(text).not.toContain('"SEC"');
        expect(text).not.toContain('Secret');
        const found = answer.labels.find((l) => l.label.name === 'Common');
        expect(found).toMatchObject({ issues: 1, teams: [{ id: h.teams.eng, key: 'ENG' }] });
      }
    });
  }

  it('label.usage counts the SEC issue for a SEC member (control)', async () => {
    const answer = await usage({ scope: 'workspace' }, seeing(samActor));
    const found = answer.labels.find((l) => l.label.name === 'Common');
    expect(found?.issues).toBe(2);
    expect(found?.teams.map((t) => t.key).sort()).toEqual(['ENG', 'SEC']);
  });

  it('label.delete of a workspace label reports only the visible issues, and rewrites the SEC one too (E7)', async () => {
    const deleted = await executor.execute('label.delete', { label: 'Common' }, seeing(zoeActor));
    expect(deleted).toMatchObject({ ok: true, result: { removedFromIssues: 1 } });
    const { rows } = await h.pool.query<{ id: string; label_ids: string[] }>(
      'SELECT id, label_ids FROM issues WHERE id = ANY($1::uuid[])',
      [[engIssue, secIssue]],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.label_ids).not.toContain(common);
    // The SEC issue's rewrite is logged to SEC's group only.
    const log = await h.pool.query<{ groups: string[] }>(
      `SELECT groups FROM sync_log WHERE model = 'Issue' AND model_id = $1
        ORDER BY sync_id DESC LIMIT 1`,
      [secIssue],
    );
    expect(log.rows[0]?.groups).toEqual([`team:${h.teams.sec}`]);
  });

  it('label.delete reports both issues to a SEC member (control)', async () => {
    const deleted = await executor.execute('label.delete', { label: spare }, seeing(samActor));
    expect(deleted).toMatchObject({ ok: true, result: { removedFromIssues: 2 } });
  });

  it('status.delete on a SEC status answers like a status that never existed, with no count', async () => {
    const { rows } = await h.pool.query<{ id: string }>(
      `SELECT id FROM workflow_statuses WHERE team_id = $1 AND name = 'Todo'`,
      [h.teams.sec],
    );
    const secTodo = rows[0]?.id ?? '';
    expect(secTodo).not.toBe('');
    // The SEC issue is on SEC's default status, so SEC's statuses do have issues to count.
    const before = await logLength();
    for (const actor of [seeing(anaActor), seeing(zoeActor)]) {
      for (const [team, unknownTeam] of [
        ['ENG', 'ENG'],
        ['SEC', 'ZZZ'],
      ] as const) {
        const unknownId = randomUUID();
        const real = await failure('status.delete', { team, status: secTodo }, actor, [
          secTodo,
          team,
        ]);
        const unknown = await failure(
          'status.delete',
          { team: unknownTeam, status: unknownId },
          actor,
          [unknownId, unknownTeam],
        );
        expect(real).toEqual(unknown);
        expect(real).toMatchObject({ code: 'NOT_FOUND' });
        expect(JSON.stringify(real)).not.toMatch(/\d+ issue/);
      }
    }
    expect(await logLength()).toBe(before);
  });
});
