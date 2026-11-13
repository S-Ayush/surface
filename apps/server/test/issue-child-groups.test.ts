// PLAN-011 S3, SPEC-011 §4.8, §5.1, AC-19, D5: where an issue's and its children's sync groups
// come from. An Issue edit keeps the groups of the row its handler locked and reads no team row
// (only a team move, M3, reads one); an Issue insert reads its team `FOR SHARE`. A child row's
// `teamId` is its issue's, whatever the handler passed, and its groups are `team:<teamId>` only.
//
// No child model is registered before PLAN-011 S5a, so the child half runs through the real repo
// with a stand-in `IssueHistory` entry over the real `issue_history` table, added by `vi.mock`.
import { teamGroup, userGroup } from '@surface/domain';
import { defineModel, enumOf, json, timestamp, uuid } from '@surface/domain/model';
import { describe, expect, it, vi } from 'vitest';
import type * as Models from '../src/sync/models.js';
import type { RowChange, TransactionRepo } from '../src/sync/repo.js';
import { scriptedDb, type Row, type Statement } from './support/scripted-db.js';

vi.mock('../src/sync/models.js', async (importOriginal) => {
  const original = await importOriginal<typeof Models>();
  const { issueHistory } = await import('../src/db/schema/index.js');
  const IssueHistory = defineModel('IssueHistory', {
    load: 'content',
    fields: {
      issueId: uuid(),
      teamId: uuid(),
      actorKind: enumOf(['user', 'api', 'mcp', 'system']),
      actorId: uuid().nullable(),
      apiKeyId: uuid().nullable(),
      kind: enumOf(['created', 'updated', 'deleted', 'restored', 'archived']),
      changes: json(),
      createdAt: timestamp(),
      updatedAt: timestamp(),
    },
  });
  const SYNCED_MODELS = {
    ...original.SYNCED_MODELS,
    IssueHistory: {
      table: issueHistory,
      def: IssueHistory,
      fixture: true,
      issueChild: true,
      groupsOf: original.groupsOfIssueChild,
      groupFields: ['issueId', 'teamId'],
      teamColumn: issueHistory.teamId,
    },
  };
  return {
    ...original,
    SYNCED_MODELS,
    isModelName: (value: string) => Object.hasOwn(SYNCED_MODELS, value),
    isIssueChild: (model: string) =>
      model === 'IssueHistory' || (original.isModelName(model) && original.isIssueChild(model)),
  };
});

const NOW = new Date('2026-11-13T10:00:00.000Z');
const AT = '2026-11-01T09:00:00.000Z';
const ENG = '0190f0c0-0000-7000-8000-00000000e000';
const SEC = '0190f0c0-0000-7000-8000-00000000c000';
const OTHER = '0190f0c0-0000-7000-8000-00000000f000';
const ISSUE = '0190f0c0-0000-7000-8000-000000000001';
const SEC_ISSUE = '0190f0c0-0000-7000-8000-000000000002';
const STATUS = '0190f0c0-0000-7000-8000-000000000051';
const ADA = '0190f0c0-0000-7000-8000-0000000000a1';
const ENTRY = '0190f0c0-0000-7000-8000-000000000071';

const team = (id: string, isPrivate: boolean): Row => ({
  id,
  private: isPrivate,
  sync_groups: isPrivate ? [teamGroup(id)] : ['workspace'],
});

function issueRow(groups: string[], teamId = ENG, id = ISSUE): Row {
  return {
    id,
    team_id: teamId,
    number: 1,
    title: 'Fix login',
    status_id: STATUS,
    priority: 0,
    assignee_id: null,
    label_ids: [],
    estimate: null,
    due_date: null,
    sort_order: 'a0V001',
    creator_id: ADA,
    started_at: null,
    completed_at: null,
    canceled_at: null,
    archived_at: null,
    deleted_at: null,
    deleted_by_id: null,
    sync_groups: groups,
    created_at: AT,
    updated_at: AT,
  };
}

const teamReads = (statements: readonly Statement[]) =>
  statements.filter(({ text }) => text.includes('from "teams"'));

const logged = (changes: readonly RowChange[]) =>
  changes.map((c) => ({ action: c.action, model: c.model, groups: [...c.groups] }));

/**
 * The repo as a handler of a model the real `ModelName` doesn't list yet would call it. (Method
 * parameters are bivariant, so the generic repo already fits this shape.)
 */
interface UntypedRepo {
  insert(model: string, row: Row): Promise<Row>;
  update(model: string, id: string, patch: Row): Promise<Row>;
}
const untyped = (repo: TransactionRepo): UntypedRepo => repo;

function world(groups: string[] = ['workspace']) {
  return scriptedDb(
    {
      teams: [team(ENG, false), team(SEC, true), team(OTHER, false)],
      issues: [issueRow(groups), issueRow([teamGroup(SEC)], SEC, SEC_ISSUE)],
    },
    { now: NOW },
  );
}

describe('Issue groups (SPEC-011 §4.8, D5)', () => {
  it('an edit keeps the locked row’s groups and reads no team row', async () => {
    // Stored groups that the team row would not give, so a recomputation would show.
    const { repo, statements } = world([teamGroup(ENG), userGroup(ADA)]);
    await repo.update('Issue', ISSUE, { title: 'Fix the login page', priority: 2 });
    expect(teamReads(statements)).toEqual([]);
    expect(logged(repo.changes())).toEqual([
      { action: 'U', model: 'Issue', groups: [teamGroup(ENG), userGroup(ADA)] },
    ]);
  });

  it('archive and unarchive read no team row either', async () => {
    const { repo, statements } = world();
    await repo.archive('Issue', ISSUE);
    await repo.unarchive('Issue', ISSUE);
    expect(teamReads(statements)).toEqual([]);
    expect(logged(repo.changes()).map((c) => c.action)).toEqual(['A', 'V']);
  });

  it('a patch naming its own team keeps the stored groups and reads no team row', async () => {
    // A team read after the issue lock breaks the §4.8 lock order, so only a real move reads one.
    const { repo, statements } = world([teamGroup(ENG), userGroup(ADA)]);
    await repo.update('Issue', ISSUE, { teamId: ENG, title: 'Fix the login page' });
    expect(teamReads(statements)).toEqual([]);
    expect(logged(repo.changes())).toEqual([
      { action: 'U', model: 'Issue', groups: [teamGroup(ENG), userGroup(ADA)] },
    ]);
  });

  it('a team move (M3) reads the new team and logs D then U with its groups', async () => {
    const { repo, statements } = world();
    await repo.update('Issue', ISSUE, { teamId: SEC });
    expect(teamReads(statements).map(({ text }) => text)).toEqual([
      'select "id", "private" from "teams" where "teams"."id" = $1 for share',
    ]);
    expect(logged(repo.changes())).toEqual([
      { action: 'D', model: 'Issue', groups: ['workspace'] },
      { action: 'U', model: 'Issue', groups: [teamGroup(SEC)] },
    ]);
  });

  it('an insert takes its team’s groups from the team row, read FOR SHARE', async () => {
    for (const [teamId, groups] of [
      [ENG, ['workspace']],
      [SEC, [teamGroup(SEC)]],
    ] as const) {
      const { repo, statements } = scriptedDb(
        { teams: [team(ENG, false), team(SEC, true)] },
        { now: NOW },
      );
      await repo.insert('Issue', {
        id: ISSUE,
        teamId,
        number: 1,
        title: 'Fix login',
        statusId: STATUS,
        sortOrder: 'a0V001',
        creatorId: ADA,
      });
      expect(teamReads(statements)).toHaveLength(1);
      expect(teamReads(statements)[0]?.text).toMatch(/for share$/);
      expect(logged(repo.changes())).toEqual([{ action: 'I', model: 'Issue', groups }]);
    }
  });
});

describe('issue child rows (SPEC-011 §5.1, AC-19)', () => {
  const entry = (teamId: string): Row => ({
    id: ENTRY,
    issueId: ISSUE,
    teamId,
    actorKind: 'user',
    actorId: ADA,
    kind: 'created',
    changes: {},
  });

  it('take the team of their issue’s row, whatever teamId the handler passed', async () => {
    const { repo, rowsOf } = world();
    const row = await untyped(repo).insert('IssueHistory', entry(OTHER));
    expect(row['teamId']).toBe(ENG);
    expect(rowsOf('issue_history').get(ENTRY)?.['team_id']).toBe(ENG);
  });

  it('are in team:<teamId> only, never the issue’s user: groups', async () => {
    // A public team's issue as S4b stores it: its team and the creator's and assignee's groups.
    const { repo } = world([teamGroup(ENG), userGroup(ADA), userGroup(OTHER)]);
    await untyped(repo).insert('IssueHistory', entry(OTHER));
    expect(logged(repo.changes())).toEqual([
      { action: 'I', model: 'IssueHistory', groups: [teamGroup(ENG)] },
    ]);
  });

  it('read the issue row, never a team row', async () => {
    const { repo, statements } = world();
    await untyped(repo).insert('IssueHistory', entry(ENG));
    expect(teamReads(statements)).toEqual([]);
    expect(statements[0]?.text).toBe('select "team_id" from "issues" where "issues"."id" = $1');
  });

  it('never move to another team through a patch', async () => {
    const { repo, rowsOf, statements } = world();
    await untyped(repo).insert('IssueHistory', entry(ENG));
    const before = statements.length;
    await untyped(repo).update('IssueHistory', ENTRY, { teamId: OTHER, changes: { title: true } });
    const update = statements.slice(before).find(({ text }) => text.startsWith('update'));
    expect(update?.text.split(' where ')[0]).not.toContain('"team_id"');
    expect(rowsOf('issue_history').get(ENTRY)?.['team_id']).toBe(ENG);
    expect(logged(repo.changes()).at(-1)).toEqual({
      action: 'U',
      model: 'IssueHistory',
      groups: [teamGroup(ENG)],
    });
  });

  it('never move to another team through a patch of their issue', async () => {
    // Re-parented under SEC's issue, the row would keep ENG's team and groups: a leak (§5.1).
    const { repo, rowsOf, statements } = world();
    await untyped(repo).insert('IssueHistory', entry(ENG));
    const before = statements.length;
    await expect(
      untyped(repo).update('IssueHistory', ENTRY, { issueId: SEC_ISSUE }),
    ).rejects.toThrow(/IssueHistory can't move to another issue/);
    expect(statements.slice(before)).toEqual([]);
    expect(rowsOf('issue_history').get(ENTRY)).toMatchObject({ issue_id: ISSUE, team_id: ENG });
    expect(logged(repo.changes()).map((c) => c.action)).toEqual(['I']);
  });

  it('get no groups, and no team, when their issue does not exist', async () => {
    const { repo, rowsOf } = scriptedDb({ teams: [team(ENG, false)] }, { now: NOW });
    await untyped(repo).insert('IssueHistory', entry(ENG));
    // The NOT NULL and foreign key on `team_id` fail the transaction in Postgres.
    expect(rowsOf('issue_history').get(ENTRY)?.['team_id']).toBeNull();
    expect(logged(repo.changes())).toEqual([{ action: 'I', model: 'IssueHistory', groups: [] }]);
  });
});
