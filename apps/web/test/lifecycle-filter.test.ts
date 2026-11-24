// PLAN-015 S4 (SPEC-015 §5.2, AC-9, §3.3): every list view filters by lifecycle with one rule, so
// a live list never shows an archived or deleted issue, the Issues tab only archived ones and the
// Recently deleted tab only deleted ones before their purgeAfter. The archive rows are flat, in
// the server's order, with the archive or deletion day.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { forListVariant, inListVariant } from '../src/features/issues/lifecycle-filter.js';
import {
  archiveGroups,
  buildGroups,
  flattenGroups,
  type ListVariant,
} from '../src/features/issues/list-model.js';
import { summary } from './archive-fixtures.js';
import { ENG, ENG_DONE, LOOKUPS, issue } from './issue-list-fixtures.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();

describe('the lifecycle filter', () => {
  it('puts each issue in exactly one view, or none once past purgeAfter (property)', () => {
    const at = fc.option(
      fc.integer({ min: 0, max: 2_000 }).map((h) => ago(h)),
      { nil: null },
    );
    fc.assert(
      fc.property(at, at, (archivedAt, deletedAt) => {
        const views = (['active', 'archived', 'deleted'] as const).filter((view) =>
          inListVariant({ archivedAt, deletedAt }, view, NOW),
        );
        const expired = deletedAt !== null && Date.parse(deletedAt) + 720 * HOUR <= NOW.getTime();
        expect(views.length).toBe(expired ? 0 : 1);
      }),
      { seed: 1504, numRuns: 300 },
    );
  });

  it('keeps the order of what it filters', () => {
    const rows = [
      { id: 'a', archivedAt: null, deletedAt: null },
      { id: 'b', archivedAt: ago(1), deletedAt: null },
      { id: 'c', archivedAt: null, deletedAt: null },
    ];
    expect(forListVariant(rows, 'active', NOW).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('applies to the live lists: an archived or deleted row of the replica never shows', () => {
    const groups = buildGroups(
      { kind: 'team', teamId: ENG },
      'active',
      [
        issue({ title: 'Live' }),
        issue({ title: 'Archived', archivedAt: ago(1) }),
        issue({ title: 'Deleted', deletedAt: ago(1) }),
      ],
      LOOKUPS,
    );
    expect(groups.flatMap((g) => g.rows.map((r) => r.title))).toEqual(['Live']);
  });
});

describe('archiveGroups (§3.3)', () => {
  const rows = (
    variant: Exclude<ListVariant, 'active'>,
    issues: Parameters<typeof archiveGroups>[2],
  ) => archiveGroups(variant, ENG, issues, LOOKUPS, NOW);

  it('lists archived issues flat in the server’s order, showing the archive day', () => {
    const groups = rows('archived', [
      summary(2, { archivedAt: '2026-11-10T10:00:00.000Z', title: 'Newer' }),
      summary(1, { archivedAt: '2026-09-01T10:00:00.000Z', title: 'Older' }),
      // Changed since it was read: deleted now, so not on the Issues tab.
      summary(3, { archivedAt: ago(5), deletedAt: ago(1) }),
    ]);
    const items = flattenGroups(groups, {}, false);
    expect(items.map((item) => item.kind)).toEqual(['row', 'row']);
    expect(groups[0]?.rows.map((r) => [r.title, r.createdLabel])).toEqual([
      ['Newer', 'Nov 10'],
      ['Older', 'Sep 1'],
    ]);
  });

  it('lists deleted issues with the deletion day, and leaves out one past purgeAfter', () => {
    const groups = rows('deleted', [
      summary(4, { deletedAt: ago(30), title: 'Recent', createdAt: '2026-01-01T10:00:00.000Z' }),
      summary(5, { deletedAt: ago(720), title: 'Expired' }),
    ]);
    expect(groups[0]?.rows.map((r) => [r.title, r.createdLabel])).toEqual([['Recent', 'Nov 15']]);
  });

  it('takes the status colour from the replica when it holds the status, gray otherwise', () => {
    const [group] = rows('archived', [
      summary(6, {
        archivedAt: ago(1),
        status: { id: ENG_DONE, name: 'Done', category: 'completed' },
      }),
      summary(7, { archivedAt: ago(1) }),
    ]);
    expect(group?.rows.map((r) => r.status.color)).toEqual(['green', 'gray']);
  });

  it('is empty when nothing belongs in the tab', () => {
    expect(rows('archived', [])).toEqual([]);
  });
});
