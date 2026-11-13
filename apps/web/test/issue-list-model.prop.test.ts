// PLAN-012 S3, AC-4: the list's order is total, so any arrival order gives the same list, and no
// issue is lost or listed twice.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildGroups,
  orderedIssueIds,
  selectIssues,
  type ListIssue,
} from '../src/features/issues/list-model.js';
import {
  DES,
  DES_DONE,
  DES_TODO,
  ENG,
  ENG_DOING,
  ENG_DONE,
  ENG_TODO,
  LOOKUPS,
  ME,
  OTHER,
  uuid,
} from './issue-list-fixtures.js';

const issueArb = fc.record({
  n: fc.integer({ min: 0, max: 40 }),
  statusId: fc.constantFrom(ENG_TODO, ENG_DOING, ENG_DONE),
  priority: fc.integer({ min: 0, max: 4 }),
  // Few distinct times and numbers, so ties are common.
  minute: fc.integer({ min: 0, max: 3 }),
  number: fc.option(fc.integer({ min: 1, max: 3 }), { nil: null }),
});

type Row = {
  n: number;
  statusId: string;
  priority: number;
  minute: number;
  number: number | null;
};

function toIssues(rows: readonly Row[]): ListIssue[] {
  // Distinct ids by index: ties on every other key fall to the id.
  return rows.map((row, i) => ({
    id: uuid(5000 + i),
    teamId: ENG,
    number: row.number,
    title: `t${String(row.n)}`,
    statusId: row.statusId,
    priority: row.priority,
    assigneeId: null,
    creatorId: uuid(1),
    labelIds: [],
    estimate: null,
    dueDate: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: '2026-11-06T12:00:00.000Z',
    updatedAt: `2026-11-12T12:0${String(row.minute)}:00.000Z`,
  }));
}

describe('the team list order is total (AC-4)', () => {
  it('is the same list whatever order the issues arrive in', () => {
    fc.assert(
      fc.property(fc.array(issueArb, { maxLength: 30 }), fc.integer(), (rows, seed) => {
        const issues = toIssues(rows);
        // Reversed and rotated: a different arrival order each time.
        const reversed = issues.toReversed();
        const shift = reversed.length === 0 ? 0 : Math.abs(seed) % reversed.length;
        const shuffled = [...reversed.slice(shift), ...reversed.slice(0, shift)];
        const scope = { kind: 'team', teamId: ENG } as const;
        const one = orderedIssueIds(buildGroups(scope, 'active', issues, LOOKUPS));
        const two = orderedIssueIds(buildGroups(scope, 'active', shuffled, LOOKUPS));
        expect(two).toEqual(one);
      }),
    );
  });

  it('lists every issue once', () => {
    fc.assert(
      fc.property(fc.array(issueArb, { maxLength: 30 }), (rows) => {
        const issues = toIssues(rows);
        const ids = orderedIssueIds(
          buildGroups({ kind: 'team', teamId: ENG }, 'active', issues, LOOKUPS),
        );
        expect([...ids].sort()).toEqual(issues.map((i) => i.id).sort());
      }),
    );
  });
});

const mixedArb = fc.array(
  fc.record({
    team: fc.constantFrom(ENG, DES),
    statusId: fc.constantFrom(ENG_TODO, ENG_DOING, ENG_DONE, DES_TODO, DES_DONE),
    assignee: fc.constantFrom(ME, OTHER, null),
    creator: fc.constantFrom(ME, OTHER),
    archived: fc.boolean(),
    deleted: fc.boolean(),
  }),
  { maxLength: 30 },
);

type Mixed = typeof mixedArb extends fc.Arbitrary<(infer T)[]> ? T : never;

function toMixed(rows: readonly Mixed[]): ListIssue[] {
  return rows.map((row, i) => ({
    ...toIssues([{ n: i, statusId: ENG_TODO, priority: 0, minute: 0, number: i + 1 }])[0]!,
    id: uuid(7000 + i),
    teamId: row.team,
    statusId: row.statusId,
    assigneeId: row.assignee,
    creatorId: row.creator,
    archivedAt: row.archived ? '2026-11-01T00:00:00.000Z' : null,
    deletedAt: row.deleted ? '2026-11-02T00:00:00.000Z' : null,
  }));
}

describe('My issues selection (AC-4)', () => {
  const closed = new Set([ENG_DONE, DES_DONE]);

  it('Assigned is exactly the assigned, open, live issues', () => {
    fc.assert(
      fc.property(mixedArb, (rows) => {
        const issues = toMixed(rows);
        const got = selectIssues(
          { kind: 'assigned', userId: ME },
          'active',
          issues,
          LOOKUPS.statuses,
        );
        const want = issues.filter(
          (i) =>
            i.assigneeId === ME &&
            !closed.has(i.statusId) &&
            i.archivedAt === null &&
            i.deletedAt === null,
        );
        expect(got.map((i) => i.id)).toEqual(want.map((i) => i.id));
      }),
    );
  });

  it('Created is exactly the issues the user created, live ones, closed included', () => {
    fc.assert(
      fc.property(mixedArb, (rows) => {
        const issues = toMixed(rows);
        const got = selectIssues(
          { kind: 'created', userId: ME },
          'active',
          issues,
          LOOKUPS.statuses,
        );
        const want = issues.filter(
          (i) => i.creatorId === ME && i.archivedAt === null && i.deletedAt === null,
        );
        expect(got.map((i) => i.id)).toEqual(want.map((i) => i.id));
      }),
    );
  });

  it('named groups are the same whatever order the issues arrive in', () => {
    fc.assert(
      fc.property(mixedArb, fc.integer(), (rows, seed) => {
        const issues = toMixed(rows);
        const reversed = issues.toReversed();
        const shift = reversed.length === 0 ? 0 : Math.abs(seed) % reversed.length;
        const permuted = [...reversed.slice(shift), ...reversed.slice(0, shift)];
        const scope = { kind: 'created', userId: ME } as const;
        const shape = (list: readonly ListIssue[]) =>
          buildGroups(scope, 'active', list, LOOKUPS).map((g) => [
            g.key,
            g.rows.map((r) => r.issueId),
          ]);
        expect(shape(permuted)).toEqual(shape(issues));
      }),
    );
  });
});
