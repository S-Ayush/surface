// SPEC-012 AC-4: the in-group order is total, and stable under shuffles; ties never swap.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compareIssuesInGroup,
  namedStatusGroups,
  statusGroups,
  type GroupableIssue,
  type GroupableStatus,
} from './issue-order.js';
import { STATUS_CATEGORIES } from './status-category.js';

const STATUS_IDS = ['s1', 's2', 's3', 's4'] as const;

const statuses: GroupableStatus[] = STATUS_IDS.map((id, i) => ({
  id,
  name: i % 2 === 0 ? 'Todo' : `Status ${i}`,
  category: STATUS_CATEGORIES[(i * 2) % STATUS_CATEGORIES.length] ?? 'backlog',
  position: `a${i}`,
}));

// Few distinct values, so equal keys are common and ties get exercised.
const issues = fc.uniqueArray(fc.uuid(), { minLength: 0, maxLength: 30 }).chain((ids) =>
  fc.tuple(
    ...ids.map((id) =>
      fc.record({
        id: fc.constant(id),
        statusId: fc.constantFrom(...STATUS_IDS),
        priority: fc.integer({ min: 0, max: 4 }),
        updatedAt: fc.constantFrom(
          '2026-11-12T10:00:00Z',
          '2026-11-12T10:00:01Z',
          '2026-11-12T12:00:00+02:00',
        ),
        number: fc.option(fc.integer({ min: 1, max: 3 }), { nil: null }),
      }),
    ),
  ),
);

describe('issue order (properties)', () => {
  it('compareIssuesInGroup is a consistent comparator: antisymmetric and transitive', () => {
    fc.assert(
      fc.property(issues, (list) => {
        for (const a of list) {
          expect(compareIssuesInGroup(a, a)).toBe(0);
          for (const b of list) {
            expect(Math.sign(compareIssuesInGroup(a, b)) + 0).toBe(
              0 - Math.sign(compareIssuesInGroup(b, a)),
            );
          }
        }
        const sorted = [...list].sort(compareIssuesInGroup);
        for (let i = 1; i < sorted.length; i++) {
          const prev = sorted[i - 1];
          const next = sorted[i];
          if (prev && next) expect(compareIssuesInGroup(prev, next)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it('statusGroups gives the same order for any shuffle of the input (a total order)', () => {
    fc.assert(
      fc.property(
        issues.chain((list) =>
          fc.tuple(
            fc.constant(list),
            fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length }),
          ),
        ),
        ([list, shuffled]) => {
          const ids = (input: readonly GroupableIssue[]) =>
            statusGroups(statuses, input).map((g) => [g.key, g.issues.map((i) => i.id)]);
          expect(ids(shuffled)).toEqual(ids(list));
        },
      ),
    );
  });

  it('namedStatusGroups gives the same groups for any shuffle, and holds every issue once', () => {
    fc.assert(
      fc.property(
        issues.chain((list) =>
          fc.tuple(
            fc.constant(list),
            fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length }),
          ),
        ),
        ([list, shuffled]) => {
          const run = (input: readonly GroupableIssue[]) =>
            namedStatusGroups(statuses, input).map((g) => [g.key, g.issues.map((i) => i.id)]);
          expect(run(shuffled)).toEqual(run(list));
          const placed = namedStatusGroups(statuses, list).flatMap((g) =>
            g.issues.map((i) => i.id),
          );
          expect([...placed].sort()).toEqual(list.map((i) => i.id).sort());
        },
      ),
    );
  });

  it('never shows an empty group', () => {
    fc.assert(
      fc.property(issues, (list) => {
        for (const g of [...statusGroups(statuses, list), ...namedStatusGroups(statuses, list)]) {
          expect(g.issues.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});
