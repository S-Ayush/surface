// PLAN-010 S3, SPEC-010 §3.2 and AC-25 (the "New label" row's `Group/Label`): the labels page's
// model, pure. Sorted by name in any case, the filter, groups with their labels, the footer count,
// what the New label and New group rows turn their text into, and who may edit.
import { userActor } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import {
  allInScope,
  groupChoices,
  inheritedCount,
  inheritedText,
  labelEntries,
  labelsAccess,
  planNewGroup,
  planNewLabel,
  scopeLabels,
  type LabelItem,
  type LabelsScope,
} from '../src/features/labels/model.js';
import { visibleIds } from '../src/features/labels/LabelTable.js';

const ENG = 'e0000000-0000-4000-8000-000000000001';
const DES = 'e0000000-0000-4000-8000-000000000002';
const team: LabelsScope = { kind: 'team', teamId: ENG, teamKey: 'ENG' };
const workspace: LabelsScope = { kind: 'workspace' };

let n = 0;
function item(name: string, extra: Partial<LabelItem> = {}): LabelItem {
  n += 1;
  return {
    id: `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    teamId: ENG,
    name,
    color: 'gray',
    description: null,
    parentId: null,
    isGroup: false,
    exclusive: true,
    archived: false,
    createdAt: '2026-11-13T10:00:00.000Z',
    ...extra,
  };
}

const size = item('Size', { isGroup: true });
const small = item('Small', { parentId: size.id });
const large = item('large', { parentId: size.id });
const perf = item('perf');
const bug = item('Bug');
const wsBug = item('Bug', { teamId: null });
const wsGroup = item('Kind', { isGroup: true, teamId: null });
const wsFeature = item('Feature', { teamId: null, parentId: wsGroup.id });
const old = item('Old', { archived: true });
const other = item('Other', { teamId: DES });
const ALL = [size, small, large, perf, bug, wsBug, wsGroup, wsFeature, old, other];

describe('scopeLabels', () => {
  it("is the scope's own labels, archived ones left out", () => {
    expect(scopeLabels(ALL, team).map((l) => l.name)).toEqual([
      'Size',
      'Small',
      'large',
      'perf',
      'Bug',
    ]);
    expect(scopeLabels(ALL, workspace).map((l) => l.name)).toEqual(['Bug', 'Kind', 'Feature']);
  });
});

describe('labelEntries (§3.2)', () => {
  const entries = (filter = '') => labelEntries(scopeLabels(ALL, team), filter);

  it('sorts by name in any case, and nests the labels of a group, also by name', () => {
    const list = entries();
    expect(list.map((e) => e.label.name)).toEqual(['Bug', 'perf', 'Size']);
    expect(list[2]?.children.map((c) => c.name)).toEqual(['large', 'Small']);
    expect(list[0]?.children).toEqual([]);
  });

  it('filters plain labels by a part of the name, any case', () => {
    expect(entries('ER').map((e) => e.label.name)).toEqual(['perf']);
    expect(entries('zzz')).toEqual([]);
  });

  it('keeps a group whose label matches, with the matching labels only, and a matching group with all', () => {
    const byLabel = entries('small');
    expect(byLabel.map((e) => e.label.name)).toEqual(['Size']);
    expect(byLabel[0]?.children.map((c) => c.name)).toEqual(['Small']);
    expect(entries('siz')[0]?.children).toHaveLength(2);
  });
});

describe('visibleIds', () => {
  it('lists a group’s labels only when it is expanded, or while filtering', () => {
    const list = labelEntries(scopeLabels(ALL, team), '');
    expect(visibleIds(list, new Set(), false)).toEqual([bug.id, perf.id, size.id]);
    expect(visibleIds(list, new Set([size.id]), false)).toEqual([
      bug.id,
      perf.id,
      size.id,
      large.id,
      small.id,
    ]);
    expect(visibleIds(list, new Set(), true)).toHaveLength(5);
  });
});

describe('the footer', () => {
  it('counts the workspace labels, not groups, archived ones or other teams', () => {
    expect(inheritedCount(ALL)).toBe(2);
    expect(inheritedText(1)).toBe('1 label inherited from workspace');
    expect(inheritedText(2)).toBe('2 labels inherited from workspace');
    expect(inheritedText(0)).toBe('0 labels inherited from workspace');
  });
});

describe('planNewLabel (AC-25)', () => {
  let counter = 0;
  const ids = () => `f0000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  const plan = (text: string, scope: LabelsScope = team) =>
    planNewLabel(text, allInScope(ALL, scope), scope, ids);

  it('makes one label from a plain name', () => {
    const result = plan('  Needs design ');
    expect(result.ok && result.steps).toEqual([
      expect.objectContaining({ name: 'Needs design', isGroup: false }),
    ]);
  });

  it('puts Group/Label and Group:Label in the existing group, matched in any case', () => {
    for (const text of ['size/Medium', ' SIZE : Medium ']) {
      const result = plan(text);
      expect(result.ok && result.steps).toEqual([
        expect.objectContaining({ name: 'Medium', group: size.id }),
      ]);
    }
  });

  it('makes the group first, single-select, when it does not exist', () => {
    const result = plan('Area/Web');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toMatchObject({ name: 'Area', isGroup: true });
    expect(result.steps[1]).toMatchObject({
      name: 'Web',
      isGroup: false,
      group: result.steps[0]?.id,
    });
  });

  it('refuses empty parts, a second separator, a taken name and a reserved word with the server’s words', () => {
    expect(plan('Size/')).toEqual({
      ok: false,
      problem: 'Type a group and a label, like Size/Small.',
    });
    expect(plan('')).toEqual({ ok: false, problem: 'Label name is required' });
    const many = plan('a/b/c');
    expect(many.ok).toBe(false);
    expect(many.ok ? '' : many.problem).toContain('/ or :');
    expect(plan('perf')).toEqual({
      ok: false,
      problem: 'A label named "perf" already exists in ENG. Choose another name.',
    });
    expect(plan('Size/small')).toMatchObject({ ok: false });
    expect(plan('Priority')).toEqual({
      ok: false,
      problem: 'Priority is a reserved name. Choose another label name.',
    });
  });

  it('a workspace label can only go in a workspace group', () => {
    const result = plan('Kind/Fresh', workspace);
    expect(result.ok && result.steps).toEqual([
      expect.objectContaining({ name: 'Fresh', group: wsGroup.id }),
    ]);
    // "Size" is ENG's group: in the workspace it does not exist, so a new group is made.
    const made = plan('Size/Extra', workspace);
    expect(made.ok && made.steps).toHaveLength(2);
  });
});

describe('planNewGroup', () => {
  it('makes one group, and refuses a name a label of the scope has', () => {
    const ids = () => 'f0000000-0000-4000-8000-0000000000aa';
    expect(planNewGroup(' Area ', ALL, team, ids)).toEqual({
      ok: true,
      steps: [{ id: ids(), name: 'Area', isGroup: true }],
    });
    expect(planNewGroup('perf', ALL, team, ids)).toMatchObject({ ok: false });
  });
});

describe('groupChoices', () => {
  it('lists live groups by name', () => {
    expect(groupChoices(scopeLabels(ALL, team)).map((g) => g.name)).toEqual(['Size']);
  });
});

describe('labelsAccess', () => {
  const as = (role: 'admin' | 'member', member: boolean) =>
    userActor({
      userId: 'u1',
      role,
      memberships: member ? [{ teamId: ENG, private: false }] : [],
    });

  it('lets a member of the team and an Admin edit and move; a non-member neither', () => {
    expect(labelsAccess(as('member', true), team)).toEqual({ edit: true, move: true });
    expect(labelsAccess(as('admin', false), team)).toEqual({ edit: true, move: true });
    expect(labelsAccess(as('member', false), team)).toEqual({ edit: false, move: false });
    expect(labelsAccess(null, team)).toEqual({ edit: false, move: false });
  });

  it('lets any member edit the workspace labels, with nothing to move', () => {
    expect(labelsAccess(as('member', false), workspace)).toEqual({ edit: true, move: false });
  });
});
