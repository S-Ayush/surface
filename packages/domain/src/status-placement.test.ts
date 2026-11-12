// PLAN-010 S2, SPEC-010 AC-3 (pure part): where `placeStatus` puts a status, and the display
// order of statuses. The server's handlers and the client's `optimistic` both call it.
import { describe, expect, it } from 'vitest';
import { placeStatus, sortStatuses, type PositionedStatus } from './workflow.js';

const s = (id: string, category: PositionedStatus['category'], position: string) => ({
  id,
  category,
  position,
});

const WORKFLOW = [
  s('done', 'completed', 'a0'),
  s('review', 'started', 'a1'),
  s('progress', 'started', 'a0'),
  s('backlog', 'backlog', 'a0'),
];

describe('sortStatuses', () => {
  it('orders by category, then by position in byte order, then id', () => {
    const rows = [s('x', 'started', 'a0V'), s('y', 'started', 'Zz'), s('z', 'started', 'a1')];
    expect(sortStatuses(rows).map((r) => r.id)).toEqual(['y', 'x', 'z']);
    expect(sortStatuses(WORKFLOW).map((r) => r.id)).toEqual([
      'backlog',
      'progress',
      'review',
      'done',
    ]);
  });
});

describe('placeStatus', () => {
  it('goes at the end of the category when no anchor is given', () => {
    const placed = placeStatus(WORKFLOW, 'started', {});
    expect(placed).toMatchObject({ ok: true });
    expect(placed.ok && placed.position > 'a1').toBe(true);
  });

  it('goes right after or right before an anchor', () => {
    const after = placeStatus(WORKFLOW, 'started', { after: 'progress' });
    const before = placeStatus(WORKFLOW, 'started', { before: 'progress' });
    expect(after.ok && after.position > 'a0' && after.position < 'a1').toBe(true);
    expect(before.ok && before.position < 'a0').toBe(true);
  });

  it('refuses an anchor of another category, naming the field', () => {
    expect(placeStatus(WORKFLOW, 'started', { after: 'done' })).toEqual({
      ok: false,
      field: 'after',
      message:
        'The after status must be in the Started category. Choose a status in the same category.',
    });
    expect(placeStatus(WORKFLOW, 'started', { before: 'nope' })).toMatchObject({
      ok: false,
      field: 'before',
    });
  });

  it('refuses to move a status next to itself', () => {
    expect(placeStatus(WORKFLOW, 'started', { after: 'review' }, 'review')).toMatchObject({
      ok: false,
      message: "Can't move a status next to itself.",
    });
  });

  it('reports a move that keeps the status in its slot as unchanged', () => {
    expect(placeStatus(WORKFLOW, 'started', { after: 'progress' }, 'review')).toMatchObject({
      ok: true,
      unchanged: true,
    });
    expect(placeStatus(WORKFLOW, 'started', { before: 'progress' }, 'review')).toMatchObject({
      ok: true,
      unchanged: false,
    });
    expect(placeStatus(WORKFLOW, 'started', {}, 'review')).toMatchObject({ unchanged: true });
  });
});
