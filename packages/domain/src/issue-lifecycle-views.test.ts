// SPEC-015 AC-9 (filters), §5.2; PLAN-015 S4: each list view shows exactly the states it lists:
// live issues in the live lists, archived ones on the Issues tab, deleted ones on the Recently
// deleted tab until `purgeAfter`, and none in two views at once.
import fc from 'fast-check';
import { propertyParameters } from '@surface/config/properties';
import { describe, expect, it } from 'vitest';
import {
  editRefusal,
  inIssueView,
  isLockedRefusal,
  ISSUE_LIST_VIEWS,
  lifecycleRefusal,
  purgeAfter,
  type IssueListView,
} from './issue-lifecycle.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const EARLIER = '2026-11-01T00:00:00.000Z';

const live = { archivedAt: null, deletedAt: null };
const archived = { archivedAt: EARLIER, deletedAt: null };
const deleted = { archivedAt: null, deletedAt: EARLIER };
const archivedAndDeleted = { archivedAt: EARLIER, deletedAt: EARLIER };

const views = (issue: Parameters<typeof inIssueView>[0], now = NOW): IssueListView[] =>
  ISSUE_LIST_VIEWS.filter((view) => inIssueView(issue, view, now));

describe('inIssueView', () => {
  it('puts a live issue in the live lists only', () => {
    expect(views(live)).toEqual(['active']);
  });

  it('puts an archived issue on the Issues tab only', () => {
    expect(views(archived)).toEqual(['archived']);
  });

  it('puts a deleted issue on the Recently deleted tab only, archived or not', () => {
    expect(views(deleted)).toEqual(['deleted']);
    expect(views(archivedAndDeleted)).toEqual(['deleted']);
  });

  it('leaves a deleted issue out from its purgeAfter on, even before the job ran', () => {
    const due = purgeAfter(EARLIER);
    expect(inIssueView(deleted, 'deleted', new Date(due.getTime() - 1))).toBe(true);
    expect(inIssueView(deleted, 'deleted', due)).toBe(false);
    expect(views(deleted, new Date(due.getTime() + 1))).toEqual([]);
  });

  it('reads Date values as the server holds them', () => {
    const row = { archivedAt: null, deletedAt: new Date(EARLIER) };
    expect(views(row)).toEqual(['deleted']);
  });

  it('never shows an issue in two views', () => {
    const instant = fc.option(
      fc.date({ min: new Date('2026-01-01'), max: new Date('2027-01-01'), noInvalidDate: true }),
      { nil: null },
    );
    fc.assert(
      fc.property(instant, instant, (archivedAt, deletedAt) => {
        expect(views({ archivedAt, deletedAt }).length).toBeLessThanOrEqual(1);
      }),
      propertyParameters({ seed: 154, numRuns: 200 }),
    );
  });
});

describe('isLockedRefusal', () => {
  it('knows the two edit refusals of §4.2', () => {
    expect(isLockedRefusal(editRefusal('ENG-42', 'archived') ?? '')).toBe(true);
    expect(isLockedRefusal(editRefusal('ENG-42', 'deleted') ?? '')).toBe(true);
  });

  it('is false for every other message', () => {
    expect(isLockedRefusal(lifecycleRefusal('ENG-42', 'expired'))).toBe(false);
    expect(isLockedRefusal(lifecycleRefusal('ENG-42', 'notDeleted'))).toBe(false);
    expect(isLockedRefusal('Title must be 255 characters or fewer.')).toBe(false);
  });
});
