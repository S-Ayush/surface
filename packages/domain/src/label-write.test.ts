// PLAN-010 S1, SPEC-010 AC-10 (pure part) and E6: the label-write rule `applyLabelAdd` that
// SPEC-011's issue operations call. Adding a label of an exclusive group replaces the issue's
// other labels of that group; a multi-select group keeps them; an issue that already carries two
// labels of an exclusive group keeps both until a write newly adds one of that group.
import { describe, expect, it } from 'vitest';
import { applyLabelAdd, type LabelInfo } from './label.js';

const labels = new Map<string, LabelInfo>([
  ['size', { parentId: null, exclusive: true }],
  ['small', { parentId: 'size', exclusive: true }],
  ['medium', { parentId: 'size', exclusive: true }],
  ['large', { parentId: 'size', exclusive: true }],
  ['platform', { parentId: null, exclusive: false }],
  ['ios', { parentId: 'platform', exclusive: true }],
  ['web', { parentId: 'platform', exclusive: true }],
  ['bug', { parentId: null, exclusive: true }],
  ['feature', { parentId: null, exclusive: true }],
]);

describe('applyLabelAdd (AC-10)', () => {
  it('replaces the other labels of an exclusive group with the added one', () => {
    expect(applyLabelAdd(labels, ['bug', 'small'], ['medium'])).toEqual(['bug', 'medium']);
  });

  it('keeps every label of a multi-select group', () => {
    expect(applyLabelAdd(labels, ['ios'], ['web'])).toEqual(['ios', 'web']);
  });

  it('adds labels outside any group without removing anything', () => {
    expect(applyLabelAdd(labels, ['bug', 'small'], ['feature'])).toEqual([
      'bug',
      'small',
      'feature',
    ]);
  });

  it('keeps two labels of an exclusive group when the write adds none of that group (E6)', () => {
    // The issue got both before Size became single-select, or before Large moved into it (D20).
    expect(applyLabelAdd(labels, ['small', 'large'], ['bug'])).toEqual(['small', 'large', 'bug']);
    expect(applyLabelAdd(labels, ['small', 'large'], [])).toEqual(['small', 'large']);
  });

  it('removes both old labels of the group on the next add of one of its labels (E6)', () => {
    expect(applyLabelAdd(labels, ['small', 'large'], ['medium'])).toEqual(['medium']);
  });

  it('treats adding a label the issue already has as a no-op that removes nothing', () => {
    expect(applyLabelAdd(labels, ['small', 'large'], ['small'])).toEqual(['small', 'large']);
  });

  it('does not bring back a label the issue had when the same write replaced it', () => {
    // Adding Small again is a no-op even after Medium replaced it: Medium is the one new label.
    expect(applyLabelAdd(labels, ['small'], ['medium', 'small'])).toEqual(['medium']);
  });

  it('lets the last of several adds of one exclusive group win', () => {
    expect(applyLabelAdd(labels, [], ['small', 'medium'])).toEqual(['medium']);
    expect(applyLabelAdd(labels, ['bug'], ['small', 'web', 'large'])).toEqual([
      'bug',
      'web',
      'large',
    ]);
  });

  it('keeps unknown label ids as they are, in no group', () => {
    expect(applyLabelAdd(labels, ['gone', 'small'], ['medium', 'other'])).toEqual([
      'gone',
      'medium',
      'other',
    ]);
  });

  it('never returns a duplicate id', () => {
    expect(applyLabelAdd(labels, ['bug', 'bug'], ['bug', 'feature', 'feature'])).toEqual([
      'bug',
      'feature',
    ]);
  });
});
