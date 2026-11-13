// SPEC-012 §3.4 items 1 and 9, AC-17, E10, E11: stepping through the list the issue was opened
// from, and going back to it.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  backTarget,
  readSourceList,
  restoreFocusOn,
  setListFocusRestorer,
  sourceListState,
  stepInfo,
  stepTarget,
} from '../src/features/issues/source-list.js';

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

describe('readSourceList (router state)', () => {
  it('reads what a list put in router state', () => {
    const source = { path: '/team/ENG', ids: IDS };
    expect(readSourceList(sourceListState(source))).toEqual(source);
  });

  it('reads nothing from the state a pasted link or Mod+K leaves', () => {
    for (const state of [undefined, null, {}, { issueSourceList: 3 }, { __TSR_index: 1 }]) {
      expect(readSourceList(state)).toBeUndefined();
    }
  });

  it('rejects a malformed list or an address that leaves the app', () => {
    expect(readSourceList({ issueSourceList: { path: '/x', ids: [1] } })).toBeUndefined();
    expect(readSourceList({ issueSourceList: { path: 'https://evil', ids: [] } })).toBeUndefined();
    expect(readSourceList({ issueSourceList: { path: '//evil', ids: [] } })).toBeUndefined();
  });
});

describe('going back (§3.4 item 9)', () => {
  it('goes to the source list, else to the issue’s team list', () => {
    expect(backTarget({ path: '/my-issues', ids: [] }, 'ENG')).toBe('/my-issues');
    expect(backTarget(undefined, 'ENG')).toBe('/team/ENG');
  });

  it('restores focus through the list’s registered restorer', () => {
    const seen: string[] = [];
    restoreFocusOn('a');
    const unregister = setListFocusRestorer((id) => seen.push(id));
    restoreFocusOn('b');
    unregister();
    restoreFocusOn('c');
    expect(seen).toEqual(['b']);
  });
});
