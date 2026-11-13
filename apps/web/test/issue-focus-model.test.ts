// PLAN-012 S3 (SPEC-012 §3.3 items 4 and 8; E1, E2, AC-5): focus follows the issue, not the row.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FocusMemory,
  LIST_SOURCE_STATE_KEY,
  readListSource,
  resolveFocus,
} from '../src/features/issues/focus-model.js';

describe('resolveFocus', () => {
  it('keeps the same issue when it moves (E1, AC-5)', () => {
    expect(resolveFocus(['a', 'b', 'c'], ['c', 'a', 'b'], 'b')).toBe('b');
  });

  it('moves to the neighbour at the same index when the issue leaves (E2)', () => {
    expect(resolveFocus(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c');
  });

  it('moves to the previous row when the last row leaves', () => {
    expect(resolveFocus(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b');
  });

  it('has no focus on an empty list or when nothing was focused', () => {
    expect(resolveFocus(['a'], [], 'a')).toBeNull();
    expect(resolveFocus(['a'], ['a'], null)).toBeNull();
  });

  it('never returns an id the list does not hold', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: 20 }), { maxLength: 15 }),
        fc.uniqueArray(fc.nat({ max: 20 }), { maxLength: 15 }),
        fc.nat({ max: 20 }),
        (previous, next, focused) => {
          const result = resolveFocus(previous.map(String), next.map(String), String(focused));
          expect(result === null || next.map(String).includes(result)).toBe(true);
          if (next.map(String).includes(String(focused))) expect(result).toBe(String(focused));
        },
      ),
    );
  });
});

describe('FocusMemory (§3.3 item 8)', () => {
  it('restores the focused issue and scroll on a revisit', () => {
    const memory = new FocusMemory();
    memory.remember('team:ENG', { focusedId: 'b', order: ['a', 'b', 'c'], scrollTop: 120 });
    expect(memory.recall('team:ENG')?.scrollTop).toBe(120);
    expect(memory.restore('team:ENG', ['a', 'b', 'c'])).toBe('b');
  });

  it('restores the neighbour when the issue left the list meanwhile', () => {
    const memory = new FocusMemory();
    memory.remember('team:ENG', { focusedId: 'b', order: ['a', 'b', 'c'], scrollTop: 0 });
    expect(memory.restore('team:ENG', ['a', 'c'])).toBe('c');
  });

  it('keeps routes and tabs apart, and knows nothing about a first visit', () => {
    const memory = new FocusMemory();
    memory.remember('my-issues:assigned', { focusedId: 'a', order: ['a'], scrollTop: 0 });
    expect(memory.restore('my-issues:created', ['a'])).toBeNull();
    expect(memory.recall('team:ENG')).toBeUndefined();
    memory.forget('my-issues:assigned');
    expect(memory.restore('my-issues:assigned', ['a'])).toBeNull();
  });
});

describe('readListSource', () => {
  it('reads what the list put in router state', () => {
    const source = { href: '/team/ENG/issues', routeKey: 'team:ENG', issueIds: ['a', 'b'] };
    expect(readListSource({ [LIST_SOURCE_STATE_KEY]: source })).toEqual(source);
  });

  it('is undefined for a pasted link and for malformed state', () => {
    expect(readListSource(undefined)).toBeUndefined();
    expect(readListSource({})).toBeUndefined();
    expect(readListSource({ [LIST_SOURCE_STATE_KEY]: { href: 1 } })).toBeUndefined();
    expect(
      readListSource({ [LIST_SOURCE_STATE_KEY]: { href: '/x', routeKey: 'k', issueIds: [1] } }),
    ).toBeUndefined();
  });
});
