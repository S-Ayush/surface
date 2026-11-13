// PLAN-012 S3 (SPEC-012 §3.3, §3.9; AC-4, AC-25 list model): the list's groups and rows as data.
import { describe, expect, it } from 'vitest';
import {
  buildGroups,
  flattenGroups,
  formatCreated,
  headerId,
  isCollapsed,
  orderedIssueIds,
  selectIssues,
} from '../src/features/issues/list-model.js';
import {
  DES,
  DES_DONE,
  DES_TODO,
  ENG,
  ENG_CANCELED,
  ENG_DOING,
  ENG_DONE,
  ENG_TODO,
  LOOKUPS,
  ME,
  OTHER,
  issue,
  uuid,
} from './issue-list-fixtures.js';

const team = { kind: 'team', teamId: ENG } as const;

describe('team list grouping (AC-4)', () => {
  it('groups by status in workflow order and hides empty groups', () => {
    const groups = buildGroups(
      team,
      'active',
      [issue({ statusId: ENG_DONE }), issue({ statusId: ENG_TODO }), issue({ statusId: ENG_DONE })],
      LOOKUPS,
    );
    expect(groups.map((g) => [g.name, g.rows.length])).toEqual([
      ['Todo', 1],
      ['Done', 2],
    ]);
  });

  it('starts Completed and Canceled collapsed, the rest expanded, unless the user chose', () => {
    const groups = buildGroups(
      team,
      'active',
      [
        issue({ statusId: ENG_DOING }),
        issue({ statusId: ENG_DONE }),
        issue({ statusId: ENG_CANCELED }),
      ],
      LOOKUPS,
    );
    expect(groups.map((g) => isCollapsed({}, g))).toEqual([false, true, true]);
    expect(isCollapsed({ [ENG_DONE]: false }, groups[1]!)).toBe(false);
    const flat = flattenGroups(groups, {});
    expect(flat.map((item) => item.kind)).toEqual(['header', 'row', 'header', 'header']);
  });

  it('orders a group by priority, then updatedAt newest first, then number descending', () => {
    const a = issue({ priority: 0, number: 1 });
    const b = issue({ priority: 1, number: 2 });
    const c = issue({ priority: 0, number: 3, updatedAt: '2026-11-13T00:00:00.000Z' });
    const d = issue({ priority: 0, number: 4 });
    const [group] = buildGroups(team, 'active', [a, b, c, d], LOOKUPS);
    expect(group?.rows.map((row) => row.issueId)).toEqual([b.id, c.id, d.id, a.id]);
  });

  it('shows ENG-… for a pending issue and the key and number otherwise', () => {
    const pending = issue({ number: null });
    const numbered = issue({ number: 42 });
    const [group] = buildGroups(team, 'active', [pending, numbered], LOOKUPS);
    const byId = new Map(group?.rows.map((row) => [row.issueId, row]));
    expect(byId.get(pending.id)).toMatchObject({ identifier: 'ENG-…', pending: true });
    expect(byId.get(numbered.id)).toMatchObject({ identifier: 'ENG-42', pending: false });
  });

  it('hides archived and deleted issues, and issues of other teams', () => {
    const live = issue();
    const groups = buildGroups(
      team,
      'active',
      [
        live,
        issue({ archivedAt: '2026-11-01T00:00:00.000Z' }),
        issue({ deletedAt: '2026-11-01T00:00:00.000Z' }),
        issue({ teamId: DES, statusId: DES_TODO }),
      ],
      LOOKUPS,
    );
    expect(orderedIssueIds(groups)).toEqual([live.id]);
  });

  it('hides the estimate column while the team has no scale, and shows an off-scale value', () => {
    const [on] = buildGroups(
      team,
      'active',
      [issue({ estimate: 3 }), issue({ estimate: 6 })],
      LOOKUPS,
    );
    expect(on?.rows.map((row) => row.estimate)).toEqual(
      expect.arrayContaining([
        { label: '3', offScale: false },
        { label: '6', offScale: true },
      ]),
    );
    const [off] = buildGroups(
      { kind: 'team', teamId: DES },
      'active',
      [issue({ teamId: DES, statusId: DES_TODO, number: 1 })],
      LOOKUPS,
    );
    expect(off?.rows[0]?.estimate).toBeUndefined();
    const [empty] = buildGroups(team, 'active', [issue()], LOOKUPS);
    expect(empty?.rows[0]?.estimate).toBeNull();
  });

  it('sorts labels by name, marks an overdue open due date, and names the assignee', () => {
    const [group] = buildGroups(
      team,
      'active',
      [issue({ labelIds: [uuid(1), uuid(2)], dueDate: '2026-11-01', assigneeId: ME })],
      LOOKUPS,
    );
    const row = group?.rows[0];
    expect(row?.labels.map((l) => l.name)).toEqual(['Bug', 'Perf']);
    expect(row?.dueDate).toEqual({ label: 'Nov 1', overdue: true });
    expect(row?.assignee).toEqual({ name: 'Ada' });
  });

  it('gives each group the status its + starts a new issue with', () => {
    const [group] = buildGroups(team, 'active', [issue({ statusId: ENG_DOING })], LOOKUPS);
    expect(group?.add).toEqual({
      teamId: ENG,
      statusId: ENG_DOING,
      statusName: 'In Progress',
      assignToMe: false,
    });
  });
});

describe('My issues (AC-4)', () => {
  const mine = issue({ assigneeId: ME, statusId: ENG_TODO });
  const mineDes = issue({ assigneeId: ME, teamId: DES, statusId: DES_TODO, number: 7 });
  const mineDone = issue({ assigneeId: ME, statusId: ENG_DONE });
  const mineCanceled = issue({ assigneeId: ME, statusId: ENG_CANCELED });
  const created = issue({ creatorId: ME, assigneeId: OTHER, statusId: ENG_DONE });
  const createdDeleted = issue({ creatorId: ME, deletedAt: '2026-11-01T00:00:00.000Z' });
  const createdArchived = issue({ creatorId: ME, archivedAt: '2026-11-01T00:00:00.000Z' });
  const all = [mine, mineDes, mineDone, mineCanceled, created, createdDeleted, createdArchived];

  it('Assigned holds exactly the user’s open issues across teams', () => {
    const picked = selectIssues({ kind: 'assigned', userId: ME }, 'active', all, LOOKUPS.statuses);
    expect(picked.map((i) => i.id).sort()).toEqual([mine.id, mineDes.id].sort());
  });

  it('Created holds the user’s non-archived, non-deleted issues, closed ones included', () => {
    const picked = selectIssues({ kind: 'created', userId: ME }, 'active', all, LOOKUPS.statuses);
    expect(picked.map((i) => i.id)).toEqual([created.id]);
  });

  it('shares a group between teams’ statuses with the same name and category', () => {
    const groups = buildGroups({ kind: 'assigned', userId: ME }, 'active', all, LOOKUPS);
    expect(groups.map((g) => [g.name, g.rows.length])).toEqual([['Todo', 2]]);
    expect(groups[0]?.rows.map((r) => r.identifier).sort()).toEqual(
      ['DES-7', `ENG-${String(mine.number)}`].sort(),
    );
    expect(groups[0]?.add).toMatchObject({ teamId: null, assignToMe: true });
    expect(groups[0]?.key).toBe('unstarted:Todo');
  });

  it('orders Created groups by category, Completed collapsed by default', () => {
    const groups = buildGroups(
      { kind: 'created', userId: ME },
      'active',
      [
        issue({ creatorId: ME, statusId: ENG_DONE }),
        issue({ creatorId: ME, statusId: DES_DONE, teamId: DES }),
        issue({ creatorId: ME, statusId: ENG_DOING }),
      ],
      LOOKUPS,
    );
    expect(groups.map((g) => g.name)).toEqual(['In Progress', 'Done']);
    expect(groups[1]?.rows).toHaveLength(2);
    expect(isCollapsed({}, groups[1]!)).toBe(true);
    expect(DES_DONE).toBeDefined();
  });
});

describe('variants', () => {
  it('archived takes archived, undeleted issues; deleted takes deleted ones with the deletion day', () => {
    const archived = issue({ archivedAt: '2026-10-01T12:00:00.000Z' });
    const deleted = issue({ deletedAt: '2026-11-10T12:00:00.000Z' });
    const live = issue();
    const rows = [archived, deleted, live];
    expect(selectIssues(team, 'archived', rows, LOOKUPS.statuses)).toEqual([archived]);
    expect(selectIssues(team, 'deleted', rows, LOOKUPS.statuses)).toEqual([deleted]);
    const [group] = buildGroups(team, 'deleted', [deleted], LOOKUPS);
    expect(group?.rows[0]?.createdLabel).toBe('Nov 10');
  });
});

describe('flattening and ids', () => {
  it('lists every issue id in the source list, collapsed groups included', () => {
    const done = issue({ statusId: ENG_DONE });
    const todo = issue();
    const groups = buildGroups(team, 'active', [done, todo], LOOKUPS);
    expect(orderedIssueIds(groups)).toEqual([todo.id, done.id]);
    expect(flattenGroups(groups, {}).map((i) => i.id)).toEqual([
      headerId(ENG_TODO),
      todo.id,
      headerId(ENG_DONE),
    ]);
  });
});

describe('formatCreated (D2)', () => {
  it('omits the year in the current year only', () => {
    expect(formatCreated('2026-11-06T12:00:00.000Z', '2026-11-13')).toBe('Nov 6');
    expect(formatCreated('2025-11-06T12:00:00.000Z', '2026-11-13')).toBe('Nov 6, 2025');
    expect(formatCreated('nope', '2026-11-13')).toBe('');
  });
});
