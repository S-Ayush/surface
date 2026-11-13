// SPEC-012 §3.4 items 1 and 9, AC-17, E10, E11: stepping through the list the issue was opened
// from, and going back to it.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { stepInfo, stepTarget, teamListPath } from '../src/features/issues/source-list.js';

const IDS = ['a', 'b', 'c', 'd'];

describe('stepInfo and stepTarget (AC-17)', () => {
  it('gives the position and the neighbours in the list order', () => {
    expect(stepInfo(IDS, 'b')).toEqual({ position: 2, total: 4, previous: 'a', next: 'c' });
    expect(stepTarget(IDS, 'b', 'next')).toBe('c');
    expect(stepTarget(IDS, 'b', 'previous')).toBe('a');
  });

  it('has nothing to step to at the ends (E10)', () => {
    expect(stepInfo(IDS, 'a')?.previous).toBeUndefined();
    expect(stepInfo(IDS, 'd')?.next).toBeUndefined();
    expect(stepTarget(IDS, 'a', 'previous')).toBeUndefined();
    expect(stepTarget(IDS, 'd', 'next')).toBeUndefined();
  });

  it('is hidden without a source list, or when the list no longer holds the issue', () => {
    expect(stepInfo(undefined, 'a')).toBeUndefined();
    expect(stepTarget(undefined, 'a', 'next')).toBeUndefined();
    expect(stepInfo(IDS, 'gone')).toBeUndefined();
  });

  it('uses the list as it is at the key press (E11)', () => {
    expect(stepTarget(IDS, 'b', 'next')).toBe('c');
    // "c" was replaced by "x" after "b" while the page was open.
    expect(stepTarget(['a', 'b', 'x', 'd'], 'b', 'next')).toBe('x');
    expect(stepInfo(['a', 'b', 'x', 'd'], 'b')?.total).toBe(4);
  });

  it('steps next then previous back to the start, for any list', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 2 }), (ids) => {
        for (let i = 0; i < ids.length - 1; i++) {
          const next = stepTarget(ids, ids[i] ?? '', 'next');
          expect(next).toBe(ids[i + 1]);
          expect(stepTarget(ids, next ?? '', 'previous')).toBe(ids[i]);
        }
        expect(stepInfo(ids, ids[0] ?? '')?.previous).toBeUndefined();
        expect(stepInfo(ids, ids[ids.length - 1] ?? '')?.next).toBeUndefined();
      }),
    );
  });
});

describe('teamListPath (§3.4 item 9)', () => {
  it('is the issue’s team list, for a page opened without a list', () => {
    expect(teamListPath('ENG')).toBe('/team/ENG');
  });
});
