// PLAN-015 S3, SPEC-015 §3.2, §5.3, §6.1: AC-16 (operation validation: only 1, 3, 6, 9 and 12
// months; auto-archive can't be off; auto-close turns on at 6 months with the first Canceled
// status and only accepts a Canceled status of the team), AC-10 (`team.updateAutomations` for the
// team's members and Admins, an API key's `teamIds` narrowing it; `issue.autoArchive` and
// `issue.autoClose` can't be called by a user, a key or MCP) and E10 (a status that archived or
// deleted issues use can't be deleted). The registered handlers also run on SQL, to show the lock
// order: the team row, the status, then the issue.
import { randomUUID } from 'node:crypto';
import {
  bindPredicates,
  comparePositions,
  countStatusIssues,
  NEW_TEAM_SETTINGS,
  statusDeleteProblem,
  userActor,
  type Actor,
} from '@surface/domain';
import { registry, teamUpdateAutomations } from '@surface/operations';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { Pool } from '../src/db/pool.js';
import type { HandlerContext } from '../src/executor/context.js';
import { narrowToKeyTeams } from '../src/executor/key-scope.js';
import { createExecutor } from '../src/executor/execute.js';
import { HANDLERS } from '../src/handlers/index.js';
import {
  updateAutomations,
  type AutomationStatus,
  type AutomationsAccess,
} from '../src/handlers/teams/automations.js';
import type { ModelRow } from '../src/sync/models.js';
import type { Repo } from '../src/sync/repo.js';
import { ADA_ID, NOW } from './support/memory-issues.js';
import { recordingDb, type Statement } from './support/scripted-db.js';

const TEAM_ID = '0190f0c0-0000-7000-8000-0000000000e1';
const OTHER_TEAM_ID = '0190f0c0-0000-7000-8000-0000000000e2';

const STATUSES: readonly AutomationStatus[] = [
  { id: 's-backlog', name: 'Backlog', category: 'backlog', position: 'a0' },
  { id: 's-done', name: 'Done', category: 'completed', position: 'a0' },
  { id: 's-wontfix', name: 'Won’t do', category: 'canceled', position: 'a1' },
  { id: 's-canceled', name: 'Canceled', category: 'canceled', position: 'a0' },
  { id: 's-dupe', name: 'Duplicate', category: 'duplicate', position: 'a0' },
];

function teamRow(over: Partial<ModelRow<'Team'>> = {}): ModelRow<'Team'> {
  return {
    ...NEW_TEAM_SETTINGS,
    id: TEAM_ID,
    key: 'ENG',
    name: 'Engineering',
    icon: null,
    defaultStatusId: 's-backlog',
    syncGroups: ['workspace'],
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...over,
  };
}

/** The rules over a fake team lock and a repo that records its `update`. */
function run(
  input: Partial<Parameters<typeof updateAutomations>[2]>,
  team: ModelRow<'Team'> | undefined = teamRow(),
) {
  const updates: Record<string, unknown>[] = [];
  const access: AutomationsAccess = {
    lockTeam: () => Promise.resolve(team),
    statuses: () => Promise.resolve(STATUSES),
  };
  const repo = {
    update: (_model: string, _id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
      return Promise.resolve({ ...team, ...patch });
    },
  } as unknown as Repo;
  const result = updateAutomations(access, repo, { teamRef: 'ENG', teamId: TEAM_ID, ...input });
  return { result, updates };
}

describe('team.updateAutomations input (AC-16)', () => {
  const parse = (value: unknown) => teamUpdateAutomations.input.safeParse(value);

  it.each([1, 3, 6, 9, 12])('accepts %i months for both settings', (months) => {
    expect(parse({ team: 'ENG', autoArchiveMonths: months }).success).toBe(true);
    expect(parse({ team: 'ENG', autoCloseMonths: months }).success).toBe(true);
  });

  it.each([0, 2, 4, 7, 13, 24, 6.5, '6'])('refuses %s months', (months) => {
    expect(parse({ team: 'ENG', autoArchiveMonths: months }).success).toBe(false);
    expect(parse({ team: 'ENG', autoCloseMonths: months }).success).toBe(false);
  });

  it('has no off switch for auto-archive, but null turns auto-close off', () => {
    expect(parse({ team: 'ENG', autoArchiveMonths: null }).success).toBe(false);
    expect(parse({ team: 'ENG', autoCloseMonths: null }).success).toBe(true);
  });

  it('wants at least one setting', () => {
    const result = parse({ team: 'ENG' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/Give at least one of/);
  });

  it('returns the settings in its output', () => {
    const output = teamUpdateAutomations.output.shape;
    expect(Object.keys(output)).toEqual(
      expect.arrayContaining(['autoArchiveMonths', 'autoCloseMonths', 'autoCloseStatusId']),
    );
  });
});

describe('team.updateAutomations rules (AC-16)', () => {
  it('changes auto-archive alone, writing only that', async () => {
    const { result, updates } = run({ autoArchiveMonths: 3 });
    const { changes } = await result;
    expect(updates).toEqual([{ autoArchiveMonths: 3 }]);
    expect(changes).toEqual({ autoArchiveMonths: { from: 6, to: 3 } });
  });

  it('turns auto-close on with 6 months and the team’s first Canceled status by position', async () => {
    const { result, updates } = run({ autoCloseMonths: 6 });
    await result;
    const first = [...STATUSES]
      .filter((s) => s.category === 'canceled')
      .sort((a, b) => comparePositions(a.position, b.position))[0];
    expect(first?.id).toBe('s-canceled');
    expect(updates).toEqual([{ autoCloseMonths: 6, autoCloseStatusId: 's-canceled' }]);
  });

  it('keeps the chosen status when only the months change', async () => {
    const team = teamRow({ autoCloseMonths: 6, autoCloseStatusId: 's-wontfix' });
    const { result, updates } = run({ autoCloseMonths: 12 }, team);
    await result;
    expect(updates).toEqual([{ autoCloseMonths: 12 }]);
  });

  it('accepts a Canceled status of the team, and turns auto-close on with it', async () => {
    const { result, updates } = run({ autoCloseMonths: 3, statusId: 's-wontfix' });
    await result;
    expect(updates).toEqual([{ autoCloseMonths: 3, autoCloseStatusId: 's-wontfix' }]);
  });

  it.each([['s-done'], ['s-backlog'], ['s-dupe']])(
    'refuses %s: only a Canceled-category status is allowed',
    async (statusId) => {
      const { result, updates } = run({ autoCloseMonths: 6, statusId });
      await expect(result).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringMatching(/needs a Canceled status/) as string,
      });
      expect(updates).toEqual([]);
    },
  );

  it('refuses a status that was deleted meanwhile with CONFLICT', async () => {
    const { result } = run({ autoCloseMonths: 6, statusId: 's-gone' });
    await expect(result).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('turns auto-close off and clears the status, so a status isn’t held by a feature that is off', async () => {
    const team = teamRow({ autoCloseMonths: 6, autoCloseStatusId: 's-canceled' });
    const { result, updates } = run({ autoCloseMonths: null }, team);
    await result;
    expect(updates).toEqual([{ autoCloseMonths: null, autoCloseStatusId: null }]);
  });

  it('refuses a status while auto-close is off or being turned off', async () => {
    for (const input of [
      { statusId: 's-wontfix' },
      { autoCloseMonths: null, statusId: 's-wontfix' },
    ]) {
      await expect(run(input).result).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Turn auto-close on to choose its status.',
      });
    }
  });

  it('changes only the status when auto-close is on already', async () => {
    const team = teamRow({ autoCloseMonths: 6, autoCloseStatusId: 's-canceled' });
    const { result, updates } = run({ statusId: 's-wontfix' }, team);
    await result;
    expect(updates).toEqual([{ autoCloseStatusId: 's-wontfix' }]);
  });

  it('writes nothing when nothing changes', async () => {
    const team = teamRow({ autoCloseMonths: 6, autoCloseStatusId: 's-canceled' });
    const { result, updates } = run({ autoArchiveMonths: 6, autoCloseMonths: 6 }, team);
    expect((await result).changes).toEqual({});
    expect(updates).toEqual([]);
  });

  it('is NOT_FOUND for a team that is gone', async () => {
    const access: AutomationsAccess = {
      lockTeam: () => Promise.resolve(undefined),
      statuses: () => Promise.resolve([]),
    };
    await expect(
      updateAutomations(access, {} as Repo, {
        teamRef: 'ENG',
        teamId: TEAM_ID,
        autoArchiveMonths: 3,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses turning auto-close on in a team with no Canceled status', async () => {
    const access: AutomationsAccess = {
      lockTeam: () => Promise.resolve(teamRow()),
      statuses: () => Promise.resolve(STATUSES.filter((s) => s.category !== 'canceled')),
    };
    await expect(
      updateAutomations(access, {} as Repo, {
        teamRef: 'ENG',
        teamId: TEAM_ID,
        autoCloseMonths: 6,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('who may change automations, and who may call the jobs’ operations (AC-10)', () => {
  const member = userActor({
    userId: ADA_ID,
    role: 'member',
    memberships: [{ teamId: TEAM_ID, private: false }],
  });
  const outsider = userActor({ userId: randomUUID(), role: 'member', memberships: [] });
  const admin = userActor({ userId: randomUUID(), role: 'admin', memberships: [] });
  const refs = { team: { id: TEAM_ID, key: 'ENG', private: false } };
  const allowed = (actor: Actor) =>
    teamUpdateAutomations.permission(bindPredicates(actor).p, refs, { team: 'ENG' });

  it('lets the team’s members and Admins change them, and not another team’s member', () => {
    expect(allowed(member)).toBe(true);
    expect(allowed(admin)).toBe(true);
    expect(allowed(outsider)).toBe(false);
  });

  it('narrows an API key to its `teamIds`: a key for another team is refused', () => {
    const key = (teamIds: string[]): Actor => ({
      ...member,
      kind: 'api',
      apiKey: { id: 'k1', scope: 'read_write', teamIds, allowDestructive: false },
    });
    expect(allowed(narrowToKeyTeams(key([TEAM_ID])))).toBe(true);
    expect(allowed(narrowToKeyTeams(key([OTHER_TEAM_ID])))).toBe(false);
  });

  // Only `connect`, `query` and `release` are used; the system-only check comes before the database.
  const client = { query: () => Promise.resolve({ rows: [], rowCount: 0 }), release() {} };
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  const executor = createExecutor({
    pool,
    registry,
    handlers: HANDLERS,
    log: pino({ level: 'silent' }),
    allowInternal: true,
    syncedModels: [],
  });
  const apiKey = { id: 'k1', scope: 'read_write', teamIds: [], allowDestructive: true } as const;
  const adminSeat = { userId: 'u1', role: 'admin', memberships: [] } as const;
  const callers: [string, Actor][] = [
    ['user', userActor(adminSeat)],
    ['api', userActor({ ...adminSeat, via: { kind: 'api', apiKey } })],
    ['mcp', userActor({ ...adminSeat, via: { kind: 'mcp', apiKey } })],
  ];

  it.each(callers)(
    'answers UNKNOWN_OPERATION to a %s actor for the jobs’ operations',
    async (_, actor) => {
      for (const name of ['issue.autoArchive', 'issue.autoClose']) {
        const outcome = await executor.execute(name, { issue: 'ENG-1' }, actor);
        expect(outcome).toMatchObject({ ok: false, error: { code: 'UNKNOWN_OPERATION' } });
      }
      expect(executor.operations(actor).map((op) => op.name)).not.toContain('issue.autoArchive');
      expect(executor.operations(actor).map((op) => op.name)).not.toContain('issue.autoClose');
    },
  );

  it('never lists them, even for the system actor, and marks both systemOnly with no ui', () => {
    for (const name of ['issue.autoArchive', 'issue.autoClose']) {
      const op = registry.get(name);
      expect(op?.systemOnly).toBe(true);
      expect(op?.ui).toBeUndefined();
    }
  });
});

describe('a status that archived or deleted issues use can’t be deleted (E10)', () => {
  it('refuses it by the SPEC-010 rule, counting archived and recently deleted issues', () => {
    const statuses = [
      { id: 'a', name: 'Backlog', category: 'backlog' as const },
      { id: 'b', name: 'Old', category: 'backlog' as const },
    ];
    const counts = countStatusIssues(
      [
        { statusId: 'b', archivedAt: NOW, deletedAt: null },
        { statusId: 'b', archivedAt: null, deletedAt: NOW },
      ],
      'b',
    );
    expect(counts).toEqual({ live: 0, archived: 1, recentlyDeleted: 1 });
    const problem = statusDeleteProblem({ statuses, statusId: 'b' }, 'a', counts, null);
    expect(problem?.reason).toBe('hasIssues');
    expect(problem?.message).toMatch(/2 issues \(2 archived or recently deleted\)/);
  });
});

// ---------------------------------------------------------------------------------------------
// The registered handlers on SQL

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const snakeRow = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [snake(key), value]));

/** Answers `select "a", "b" from "table" …` with the table's fixture row, columns in order. */
function answerFrom(pick: (table: string, text: string) => Record<string, unknown> | undefined) {
  return (text: string): unknown[][] => {
    const match = /^select (.+?) from "(\w+)"/.exec(text);
    const row = match?.[2] === undefined ? undefined : pick(match[2], text);
    if (match?.[1] === undefined || row === undefined) return [];
    const columns = match[1].split(', ').map((column) => column.replace(/^.*"(\w+)"$/, '$1'));
    return [columns.map((column) => row[column] ?? null)];
  };
}

const EARLIER = new Date('2026-05-01T00:00:00.000Z');

async function runHandler(
  name: 'issue.autoArchive' | 'issue.autoClose' | 'team.updateAutomations',
  fixtures: {
    team: Record<string, unknown>;
    issue?: Record<string, unknown>;
    statusCategory: string;
  },
  input: Record<string, unknown>,
) {
  const found = HANDLERS.find((h) => h.op.name === name);
  if (!found) throw new Error(`no handler for ${name}`);
  const { db, statements } = recordingDb(
    answerFrom((table, text) => {
      if (table === 'teams') return snakeRow(fixtures.team);
      if (table === 'issues') return fixtures.issue ? snakeRow(fixtures.issue) : undefined;
      if (table === 'workflow_statuses') {
        // `FOR KEY SHARE` is the auto-close status; a plain read is the issue's own.
        return text.includes('for key share')
          ? { id: 's-canceled', team_id: TEAM_ID, category: 'canceled' }
          : { id: 's-canceled', category: fixtures.statusCategory };
      }
      return undefined;
    }),
  );
  const note = (method: string, patch: Record<string, unknown> = {}) => {
    statements.push({ text: `repo.${method}`, params: [] });
    return Promise.resolve({
      ...fixtures.issue,
      ...fixtures.team,
      ...patch,
      createdAt: NOW,
      updatedAt: NOW,
    });
  };
  const repo = {
    archive: () => note('archive', { archivedAt: NOW }),
    update: (_m: string, _id: string, patch: Record<string, unknown>) => note('update', patch),
  };
  const issueId = typeof fixtures.issue?.['id'] === 'string' ? fixtures.issue['id'] : randomUUID();
  const ctx = {
    actor: { kind: 'system', groups: [], publicTeams: [], memberOf: [] } satisfies Actor,
    tx: db,
    repo,
    refs: {
      issue: { id: issueId, teamId: TEAM_ID, key: 'ENG-1' },
      team: { id: TEAM_ID, key: 'ENG', private: false },
    },
    now: () => NOW,
    emit: () => undefined,
    audit: () => undefined,
    publicUrl: 'https://surface.test',
  } as unknown as HandlerContext;
  // A refusal is part of the case; only the order of statements is checked here.
  await found.run(ctx, found.op.input.parse(input)).catch(() => undefined);
  return statements.map((s: Statement) => s.text);
}

describe('the registered handlers take their locks in order (SPEC-011 §4.8)', () => {
  const issue = {
    id: randomUUID(),
    teamId: TEAM_ID,
    number: 1,
    statusId: 's-done',
    updatedAt: EARLIER,
    completedAt: EARLIER,
    archivedAt: null,
    deletedAt: null,
    syncGroups: ['workspace'],
  };
  const team = {
    id: TEAM_ID,
    key: 'ENG',
    autoArchiveMonths: 1,
    autoCloseMonths: 1,
    autoCloseStatusId: 's-canceled',
  };

  it('issue.autoArchive: the team row FOR SHARE, then the issue FOR UPDATE, then the write', async () => {
    const texts = await runHandler(
      'issue.autoArchive',
      { team, issue, statusCategory: 'completed' },
      { issue: 'ENG-1' },
    );
    expect(texts[0]).toMatch(/^select .* from "teams" where .* for share$/);
    expect(texts[1]).toMatch(/^select .* from "issues" where .* for update$/);
    expect(texts.indexOf('repo.archive')).toBeGreaterThan(1);
  });

  it('issue.autoClose: the team FOR SHARE, the status FOR KEY SHARE, the issue FOR UPDATE, then the write', async () => {
    const texts = await runHandler(
      'issue.autoClose',
      { team, issue, statusCategory: 'backlog' },
      { issue: 'ENG-1' },
    );
    expect(texts[0]).toMatch(/^select .* from "teams" where .* for share$/);
    expect(texts[1]).toMatch(/^select .* from "workflow_statuses" where .* for key share$/);
    expect(texts[2]).toMatch(/^select .* from "issues" where .* for update$/);
    expect(texts.indexOf('repo.update')).toBeGreaterThan(2);
  });

  it('team.updateAutomations: the team row FOR UPDATE first, then the statuses, then the write', async () => {
    const texts = await runHandler(
      'team.updateAutomations',
      {
        team: { ...team, autoCloseMonths: null, autoCloseStatusId: null },
        statusCategory: 'canceled',
      },
      { team: 'ENG', autoCloseMonths: 6 },
    );
    expect(texts[0]).toMatch(/^select .* from "teams" where .* for update$/);
    expect(texts[1]).toMatch(/from "workflow_statuses"/);
    expect(texts.indexOf('repo.update')).toBeGreaterThan(1);
  });

  it('writes nothing for an issue that is not due', async () => {
    const fresh = { ...issue, updatedAt: NOW, completedAt: NOW };
    const texts = await runHandler(
      'issue.autoArchive',
      { team, issue: fresh, statusCategory: 'completed' },
      { issue: 'ENG-1' },
    );
    expect(texts.some((t) => t.startsWith('repo.'))).toBe(false);
  });
});
