// SPEC-012 AC-4: order inside a group (D17), status groups, and named groups for My issues.
import { describe, expect, it } from 'vitest';
import {
  compareIssuesInGroup,
  namedStatusGroups,
  startsCollapsed,
  statusGroups,
  type GroupableIssue,
  type GroupableStatus,
} from './issue-order.js';

const issue = (id: string, over: Partial<GroupableIssue> = {}): GroupableIssue => ({
  id,
  statusId: 's-progress',
  priority: 0,
  updatedAt: '2026-11-12T10:00:00Z',
  number: 1,
  ...over,
});

describe('compareIssuesInGroup', () => {
  const sort = (issues: GroupableIssue[]) =>
    [...issues].sort(compareIssuesInGroup).map((i) => i.id);

  it('puts Urgent first and No priority last', () => {
    const issues = [0, 4, 3, 2, 1].map((priority) => issue(`p${priority}`, { priority }));
    expect(sort(issues)).toEqual(['p1', 'p2', 'p3', 'p4', 'p0']);
  });

  it('orders equal priorities by updatedAt, newest first, across time-zone offsets', () => {
    const a = issue('a', { updatedAt: '2026-11-12T10:00:00Z' });
    const b = issue('b', { updatedAt: '2026-11-12T11:30:00+02:00' }); // 09:30Z, older
    const c = issue('c', { updatedAt: '2026-11-12T10:00:01Z' });
    expect(sort([a, b, c])).toEqual(['c', 'a', 'b']);
  });

  it('orders equal times by number, highest first, with pending issues on top', () => {
    const issues = [
      issue('n1', { number: 1 }),
      issue('n9', { number: 9 }),
      issue('pending', { number: null }),
    ];
    expect(sort(issues)).toEqual(['pending', 'n9', 'n1']);
  });
});

describe('statusGroups', () => {
  const statuses: GroupableStatus[] = [
    { id: 's-done', name: 'Done', category: 'completed', position: 'a0' },
    { id: 's-todo', name: 'Todo', category: 'unstarted', position: 'a0' },
    { id: 's-progress', name: 'In Progress', category: 'started', position: 'a0' },
    { id: 's-review', name: 'In Review', category: 'started', position: 'a1' },
    { id: 's-backlog', name: 'Backlog', category: 'backlog', position: 'a0' },
    { id: 's-canceled', name: 'Canceled', category: 'canceled', position: 'a0' },
  ];

  it('lists groups in category order, then position, and hides empty ones', () => {
    const groups = statusGroups(statuses, [
      issue('1', { statusId: 's-review' }),
      issue('2', { statusId: 's-done' }),
      issue('3', { statusId: 's-progress' }),
      issue('4', { statusId: 's-backlog' }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(['Backlog', 'In Progress', 'In Review', 'Done']);
    expect(groups.map((g) => g.key)).toEqual(['s-backlog', 's-progress', 's-review', 's-done']);
  });

  it('orders by byte position, so "B" sorts before "a"', () => {
    const groups = statusGroups(
      [
        { id: 'x', name: 'X', category: 'started', position: 'a' },
        { id: 'y', name: 'Y', category: 'started', position: 'B' },
      ],
      [issue('1', { statusId: 'x' }), issue('2', { statusId: 'y' })],
    );
    expect(groups.map((g) => g.name)).toEqual(['Y', 'X']);
  });

  it('orders the issues of each group and drops issues on unknown statuses', () => {
    const groups = statusGroups(statuses, [
      issue('low', { priority: 4 }),
      issue('urgent', { priority: 1 }),
      issue('lost', { statusId: 'gone' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.issues.map((i) => i.id)).toEqual(['urgent', 'low']);
  });

  it('breaks full ties by id so the order never depends on input order', () => {
    const a = issue('a');
    const b = issue('b');
    expect(statusGroups(statuses, [a, b])[0]?.issues.map((i) => i.id)).toEqual(['a', 'b']);
    expect(statusGroups(statuses, [b, a])[0]?.issues.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('collapses Completed and Canceled by default only', () => {
    expect(startsCollapsed('completed')).toBe(true);
    expect(startsCollapsed('canceled')).toBe(true);
    for (const category of ['triage', 'backlog', 'unstarted', 'started', 'duplicate'] as const) {
      expect(startsCollapsed(category)).toBe(false);
    }
  });
});

describe('namedStatusGroups (My issues)', () => {
  const statuses: GroupableStatus[] = [
    { id: 'eng-todo', name: 'Todo', category: 'unstarted', position: 'a1' },
    { id: 'des-todo', name: 'Todo', category: 'unstarted', position: 'a0' },
    { id: 'eng-prog', name: 'In Progress', category: 'started', position: 'a0' },
    { id: 'des-doing', name: 'Doing', category: 'started', position: 'a0' },
    { id: 'eng-done', name: 'Done', category: 'completed', position: 'a0' },
  ];

  it('merges statuses with the same name and category across teams', () => {
    const groups = namedStatusGroups(statuses, [
      issue('1', { statusId: 'eng-todo' }),
      issue('2', { statusId: 'des-todo' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe('Todo');
    expect(groups[0]?.issues).toHaveLength(2);
    expect(groups[0]?.status.id).toBe('des-todo'); // the lowest position
  });

  it('orders groups by category, then lowest position, then name', () => {
    const groups = namedStatusGroups(statuses, [
      issue('1', { statusId: 'eng-done' }),
      issue('2', { statusId: 'eng-prog' }),
      issue('3', { statusId: 'des-doing' }),
      issue('4', { statusId: 'eng-todo' }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(['Todo', 'Doing', 'In Progress', 'Done']);
  });

  it('keeps same name in different categories apart', () => {
    const groups = namedStatusGroups(
      [
        { id: 'a', name: 'Review', category: 'started', position: 'a0' },
        { id: 'b', name: 'Review', category: 'completed', position: 'a0' },
      ],
      [issue('1', { statusId: 'a' }), issue('2', { statusId: 'b' })],
    );
    expect(groups.map((g) => g.key)).toEqual(['started:Review', 'completed:Review']);
  });
});
