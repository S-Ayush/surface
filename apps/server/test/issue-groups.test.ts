// PLAN-011 S4b, SPEC-011 §5.7, AC-26 (unit part), E28, E29: the sync groups of issue rows. A
// private team's issue is in `team:<teamId>` only; a public team's also in `user:<creatorId>` and
// `user:<assigneeId>`. An assignee change on a public team's issue is a group change: the repo
// logs `D` with the old groups, then `U` with the new ones, from the locked row alone (§4.8). Child
// rows are in `team:<teamId>` only (`issue-child-groups.test.ts` runs them through the repo).
import { teamGroup, userGroup } from '@surface/domain';
import fc from 'fast-check';
import { propertyParameters } from '@surface/config/properties';
import { describe, expect, it } from 'vitest';
import { groupsOfIssueChild, issueGroups, issueGroupsOnUpdate } from '../src/sync/models.js';
import type { RowChange } from '../src/sync/repo.js';
import { scriptedDb, type Row, type Statement } from './support/scripted-db.js';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const AT = '2026-11-01T09:00:00.000Z';
const ENG = '0190f0c0-0000-7000-8000-00000000e000';
const SEC = '0190f0c0-0000-7000-8000-00000000c000';
const ISSUE = '0190f0c0-0000-7000-8000-000000000001';
const STATUS = '0190f0c0-0000-7000-8000-000000000051';
const ADA = '0190f0c0-0000-7000-8000-0000000000a1';
const BEA = '0190f0c0-0000-7000-8000-0000000000b2';
const CAL = '0190f0c0-0000-7000-8000-0000000000c3';

const team = (id: string, isPrivate: boolean): Row => ({ id, private: isPrivate });
const teams = [team(ENG, false), team(SEC, true)];

function issueRow(
  groups: string[],
  { teamId = ENG, assigneeId = null }: { teamId?: string; assigneeId?: string | null } = {},
): Row {
  return {
    id: ISSUE,
    team_id: teamId,
    number: 1,
    title: 'Fix login',
    status_id: STATUS,
    priority: 0,
    assignee_id: assigneeId,
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

const newIssue = (teamId: string, assigneeId?: string) => ({
  id: ISSUE,
  teamId,
  number: 1,
  title: 'Fix login',
  statusId: STATUS,
  sortOrder: 'a0V001',
  creatorId: ADA,
  ...(assigneeId === undefined ? {} : { assigneeId }),
});

const teamReads = (statements: readonly Statement[]) =>
  statements.filter(({ text }) => text.includes('from "teams"'));

const logged = (changes: readonly RowChange[]) =>
  changes.map((c) => ({ action: c.action, groups: [...c.groups] }));

describe('an issue’s groups (SPEC-011 §5.7)', () => {
  it('are team:<teamId> only for a private team, whoever created or is assigned it', () => {
    expect(issueGroups({ creatorId: ADA, assigneeId: BEA }, { id: SEC, private: true })).toEqual([
      teamGroup(SEC),
    ]);
  });

  it('add the creator and the assignee for a public team', () => {
    expect(issueGroups({ creatorId: ADA, assigneeId: null }, { id: ENG, private: false })).toEqual([
      teamGroup(ENG),
      userGroup(ADA),
    ]);
    expect(issueGroups({ creatorId: ADA, assigneeId: BEA }, { id: ENG, private: false })).toEqual([
      teamGroup(ENG),
      userGroup(ADA),
      userGroup(BEA),
    ]);
    // Assigned to its creator: one user group.
    expect(issueGroups({ creatorId: ADA, assigneeId: ADA }, { id: ENG, private: false })).toEqual([
      teamGroup(ENG),
      userGroup(ADA),
    ]);
  });

  it('fail loudly for an issue with no creator, whose update rule would misread it', () => {
    for (const isPrivate of [false, true]) {
      expect(() => issueGroups({ assigneeId: BEA }, { id: ENG, private: isPrivate })).toThrow(
        /needs a creatorId/,
      );
    }
  });

  it('never put a private team’s issue in a user: group, whatever the edits (property)', () => {
    const user = fc.constantFrom(ADA, BEA, CAL, null);
    fc.assert(
      fc.property(
        fc.boolean(),
        user,
        fc.array(user, { maxLength: 6 }),
        (isPrivate, first, next) => {
          const teamId = isPrivate ? SEC : ENG;
          let groups = issueGroups(
            { creatorId: ADA, assigneeId: first },
            { id: teamId, private: isPrivate },
          );
          for (const assigneeId of next) {
            const row = { id: ISSUE, teamId, creatorId: ADA, assigneeId };
            groups = [...(issueGroupsOnUpdate(row, { groups, teamId }, { assigneeId }) ?? [])];
            // From the stored groups alone, the same as from the team row.
            expect(groups).toEqual(issueGroups(row, { id: teamId, private: isPrivate }));
          }
          if (isPrivate) expect(groups).toEqual([teamGroup(SEC)]);
          else expect(groups).toContain(userGroup(ADA));
        },
      ),
      // Private-team visibility: every case in every tier (SPEC-004 D12).
      propertyParameters({ seed: 4242, numRuns: 200 }, { full: true }),
    );
  });

  it('of an issue child are team:<teamId> only (§5.1)', () => {
    expect(groupsOfIssueChild({ teamId: ENG, creatorId: ADA, assigneeId: BEA })).toEqual([
      teamGroup(ENG),
    ]);
  });
});

describe('the repo’s issue groups', () => {
  it('on insert read the team row FOR SHARE, and give a public issue its people (AC-26)', async () => {
    for (const [teamId, assigneeId, groups] of [
      [ENG, BEA, [teamGroup(ENG), userGroup(ADA), userGroup(BEA)]],
      [ENG, undefined, [teamGroup(ENG), userGroup(ADA)]],
      [SEC, BEA, [teamGroup(SEC)]],
    ] as const) {
      const { repo, statements } = scriptedDb({ teams }, { now: NOW });
      await repo.insert('Issue', newIssue(teamId, assigneeId));
      expect(teamReads(statements).map(({ text }) => text)).toEqual([
        'select "id", "private" from "teams" where "teams"."id" = $1 for share',
      ]);
      expect(logged(repo.changes())).toEqual([{ action: 'I', groups }]);
    }
  });

  it('assigning a public issue to someone logs D with the old groups, then U with the new (E28)', async () => {
    const before = [teamGroup(ENG), userGroup(ADA)];
    const { repo, statements, rowsOf } = scriptedDb(
      { teams, issues: [issueRow(before)] },
      { now: NOW },
    );
    await repo.update('Issue', ISSUE, { assigneeId: BEA });
    const after = [teamGroup(ENG), userGroup(ADA), userGroup(BEA)];
    expect(logged(repo.changes())).toEqual([
      { action: 'D', groups: before },
      { action: 'U', groups: after },
    ]);
    // Stored too (the fake keeps Postgres's array literal).
    expect(rowsOf('issues').get(ISSUE)?.['sync_groups']).toBe(
      `{${after.map((g) => `"${g}"`).join(',')}}`,
    );
    // From the locked row alone: no team read after the issue lock (§4.8).
    expect(teamReads(statements)).toEqual([]);
  });

  it('reassigning it away logs D with the old assignee’s group, then U without it (E29)', async () => {
    const before = [teamGroup(ENG), userGroup(ADA), userGroup(BEA)];
    for (const [assigneeId, after] of [
      [CAL, [teamGroup(ENG), userGroup(ADA), userGroup(CAL)]],
      [null, [teamGroup(ENG), userGroup(ADA)]],
    ] as const) {
      const { repo, statements } = scriptedDb(
        { teams, issues: [issueRow(before, { assigneeId: BEA })] },
        { now: NOW },
      );
      await repo.update('Issue', ISSUE, { assigneeId });
      expect(logged(repo.changes())).toEqual([
        { action: 'D', groups: before },
        { action: 'U', groups: after },
      ]);
      expect(teamReads(statements)).toEqual([]);
    }
  });

  it('keeps a public issue’s groups, with one U, when the assignee doesn’t change', async () => {
    const groups = [teamGroup(ENG), userGroup(ADA), userGroup(BEA)];
    const { repo } = scriptedDb(
      { teams, issues: [issueRow(groups, { assigneeId: BEA })] },
      { now: NOW },
    );
    await repo.update('Issue', ISSUE, { title: 'Fix the login page', assigneeId: BEA });
    expect(logged(repo.changes())).toEqual([{ action: 'U', groups }]);
  });

  it('keeps a private issue in its team’s group alone when it is assigned', async () => {
    const { repo, statements } = scriptedDb(
      { teams, issues: [issueRow([teamGroup(SEC)], { teamId: SEC })] },
      { now: NOW },
    );
    await repo.update('Issue', ISSUE, { assigneeId: BEA });
    expect(logged(repo.changes())).toEqual([{ action: 'U', groups: [teamGroup(SEC)] }]);
    expect(teamReads(statements)).toEqual([]);
  });

  it('refuses to edit an issue still grouped as before partial loading, and writes nothing', async () => {
    // S3–S4 stored `workspace`: guessing its team's privacy could leak a private issue.
    const { repo } = scriptedDb({ teams, issues: [issueRow(['workspace'])] }, { now: NOW });
    await expect(repo.update('Issue', ISSUE, { assigneeId: BEA })).rejects.toThrow(
      /groups from before partial issue loading/,
    );
    expect(repo.changes()).toEqual([]);
  });

  it('refuses to change an issue’s creator, whose user: group tells public from private', async () => {
    const { repo, statements } = scriptedDb(
      { teams, issues: [issueRow([teamGroup(ENG), userGroup(ADA)])] },
      { now: NOW },
    );
    await expect(repo.update('Issue', ISSUE, { creatorId: BEA })).rejects.toThrow(
      /can't change its creatorId/,
    );
    // Before anything is read or written.
    expect(statements).toEqual([]);
    expect(repo.changes()).toEqual([]);
  });

  it('refuses an Issue insert without a creator', async () => {
    const { repo } = scriptedDb({ teams }, { now: NOW });
    const { creatorId: _creator, ...noCreator } = newIssue(ENG);
    // The column is NOT NULL; the groups would fail first, before any write.
    await expect(repo.insert('Issue', noCreator as never)).rejects.toThrow(/needs a creatorId/);
    expect(repo.changes()).toEqual([]);
  });
});

describe('the repo’s bulk writes', () => {
  it('refuse an Issue patch of a field its groups come from', async () => {
    for (const patch of [{ assigneeId: BEA }, { creatorId: BEA }, { teamId: SEC }]) {
      const { repo } = scriptedDb(
        { teams, issues: [issueRow([teamGroup(ENG), userGroup(ADA)])] },
        { now: NOW },
      );
      await expect(
        repo.updateWhere('Issue', [ISSUE], patch, { touchUpdatedAt: false }),
      ).rejects.toThrow();
      expect(repo.changes()).toEqual([]);
    }
  });
});
