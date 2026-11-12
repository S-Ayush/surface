// PLAN-010 S1: the pure label rules of SPEC-010 §4.2. AC-9 (names and group rules), AC-13 (the
// label limits), AC-25 (`parseLabelInput`), E14 (archived group), E18 (`/` and `:`) and E19
// (reserved words). The label-write rule (AC-10) is in `label-write.test.ts`.
import { describe, expect, it } from 'vitest';
import {
  LABEL_LIMITS,
  RESERVED_LABEL_NAMES,
  labelGroupProblem,
  labelLimitProblem,
  labelNameProblem,
  parseLabelInput,
  type LabelGroupCandidate,
} from './label.js';

const ENG = '0190f0c0-0000-7000-8000-00000000e000';
const DES = '0190f0c0-0000-7000-8000-00000000d000';

describe('labelNameProblem (AC-9, E18, E19)', () => {
  it('accepts 1–50 characters after trimming', () => {
    expect(labelNameProblem('Bug')).toBeUndefined();
    expect(labelNameProblem(`  ${'x'.repeat(50)}  `)).toBeUndefined();
    // Other punctuation is fine: only / and : separate a group from a label.
    expect(labelNameProblem('Needs-QA (iOS) & web')).toBeUndefined();
  });

  it('refuses an empty or too long name', () => {
    expect(labelNameProblem('  ')).toBe('Label name is required');
    expect(labelNameProblem('x'.repeat(51))).toBe('Label name must be at most 50 characters long');
  });

  it('refuses / and :, pointing at groups (E18)', () => {
    for (const name of ['Size/Small', 'Size:Small', 'a/', ':b']) {
      expect(labelNameProblem(name), name).toBe(
        "Label names can't contain / or :. Use a group instead, like Size/Small.",
      );
    }
  });

  it('refuses every reserved filter word in any case, naming it (E19)', () => {
    expect(RESERVED_LABEL_NAMES).toEqual([
      'assignee',
      'cycle',
      'effort',
      'estimate',
      'hours',
      'priority',
      'project',
      'state',
      'status',
    ]);
    expect(labelNameProblem('Priority')).toBe(
      'Priority is a reserved name. Choose another label name.',
    );
    expect(labelNameProblem(' STATUS ')).toBe(
      'Status is a reserved name. Choose another label name.',
    );
    for (const word of RESERVED_LABEL_NAMES) {
      expect(labelNameProblem(word.toUpperCase()), word).toMatch(/is a reserved name/);
    }
    // Only the exact word: a label may contain one.
    expect(labelNameProblem('Priority support')).toBeUndefined();
  });
});

describe('labelLimitProblem (AC-13)', () => {
  it('allows the 500th label in a scope and refuses the 501st, naming the limit', () => {
    expect(LABEL_LIMITS).toEqual({ perScope: 500, perGroup: 250 });
    expect(labelLimitProblem('team', { inScope: 499 })).toBeUndefined();
    expect(labelLimitProblem('team', { inScope: 500 })).toBe(
      'A team can have at most 500 labels. Delete one first.',
    );
    expect(labelLimitProblem('workspace', { inScope: 500 })).toBe(
      'The workspace can have at most 500 labels. Delete one first.',
    );
  });

  it('allows the 250th label in a group and refuses the 251st', () => {
    expect(labelLimitProblem('team', { inScope: 300, inGroup: 249 })).toBeUndefined();
    expect(labelLimitProblem('team', { inScope: 300, inGroup: 250 })).toBe(
      'A label group can have at most 250 labels. Delete one first.',
    );
  });
});

describe('parseLabelInput (AC-25)', () => {
  it('reads Group/Label and Group:Label, trimming spaces', () => {
    expect(parseLabelInput('Size/Small')).toEqual({ ok: true, group: 'Size', name: 'Small' });
    expect(parseLabelInput(' Size : Small ')).toEqual({ ok: true, group: 'Size', name: 'Small' });
  });

  it('reads a plain name as a label with no group', () => {
    expect(parseLabelInput('  Bug ')).toEqual({ ok: true, group: null, name: 'Bug' });
  });

  it('refuses empty parts', () => {
    for (const text of ['', '   ', '/Small', 'Size/', ' : ']) {
      expect(parseLabelInput(text).ok, text).toBe(false);
    }
    expect(parseLabelInput('Size/ ')).toEqual({
      ok: false,
      problem: 'Type a group and a label, like Size/Small.',
    });
  });

  it('splits at the first separator, leaving a second one to the name check', () => {
    const parsed = parseLabelInput('Size/Small/Tiny');
    expect(parsed).toEqual({ ok: true, group: 'Size', name: 'Small/Tiny' });
    if (parsed.ok) expect(labelNameProblem(parsed.name)).toMatch(/can't contain/);
  });
});

describe('labelGroupProblem (AC-9, E14)', () => {
  const group = (fields: Partial<LabelGroupCandidate> = {}): LabelGroupCandidate => ({
    name: 'Size',
    teamId: ENG,
    isGroup: true,
    parentId: null,
    archivedAt: null,
    ...fields,
  });

  it('accepts a live group in the same scope', () => {
    expect(labelGroupProblem({ teamId: ENG, isGroup: false }, group())).toBeUndefined();
    expect(
      labelGroupProblem({ teamId: null, isGroup: false }, group({ teamId: null })),
    ).toBeUndefined();
  });

  it('refuses a group in another scope', () => {
    expect(labelGroupProblem({ teamId: ENG, isGroup: false }, group({ teamId: DES }))).toBe(
      "Team labels can only go in their team's groups.",
    );
    expect(labelGroupProblem({ teamId: ENG, isGroup: false }, group({ teamId: null }))).toBe(
      "Team labels can only go in their team's groups.",
    );
    expect(labelGroupProblem({ teamId: null, isGroup: false }, group())).toBe(
      'Workspace labels can only go in workspace groups.',
    );
  });

  it('keeps groups one level deep', () => {
    expect(labelGroupProblem({ teamId: ENG, isGroup: true }, group())).toBe(
      "A label group can't go inside another group.",
    );
    expect(
      labelGroupProblem({ teamId: ENG, isGroup: false }, group({ name: 'Bug', isGroup: false })),
    ).toBe('Bug is not a label group. Choose a group, or create one first.');
    expect(
      labelGroupProblem({ teamId: ENG, isGroup: false }, group({ parentId: 'other' })),
    ).toMatch(/is not a label group/);
  });

  it('refuses an archived group (E14)', () => {
    expect(
      labelGroupProblem(
        { teamId: ENG, isGroup: false },
        group({ archivedAt: '2026-11-12T10:00:00.000Z' }),
      ),
    ).toBe('The Size group is archived. Unarchive the group first.');
  });
});
