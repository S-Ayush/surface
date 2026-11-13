// PLAN-010 S3, SPEC-010 AC-9, AC-12 (group refusal), AC-13 (limits), AC-24 (the move plan), E14,
// E18-E21: the pure checks the handlers and the client's `optimistic` share.
import { describe, expect, it } from 'vitest';
import { LABEL_LIMITS } from './label.js';
import {
  labelArchivePlan,
  labelUnarchivePlan,
  labelCreateProblem,
  labelDeleteProblem,
  labelMovePlan,
  labelUpdateProblem,
  type LabelFacts,
} from './label-rules.js';

const ENG = 'e0000000-0000-4000-8000-000000000001';
const ENG_SCOPE = { teamId: ENG, teamKey: 'ENG' };
const WORKSPACE = { teamId: null, teamKey: null };

let n = 0;
function label(fields: Partial<LabelFacts> & { name: string }): LabelFacts {
  n += 1;
  return {
    id: `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    teamId: ENG,
    parentId: null,
    isGroup: false,
    exclusive: true,
    archivedAt: null,
    ...fields,
  };
}

const size = label({ name: 'Size', isGroup: true });
const small = label({ name: 'Small', parentId: size.id });
const bug = label({ name: 'Bug' });
const teamLabels = [size, small, bug];

describe('labelCreateProblem', () => {
  it('accepts a new name, in a group or not', () => {
    expect(labelCreateProblem(teamLabels, ENG_SCOPE, { name: 'Perf', isGroup: false })).toBe(
      undefined,
    );
    expect(
      labelCreateProblem(teamLabels, ENG_SCOPE, { name: 'Large', isGroup: false, group: size }),
    ).toBe(undefined);
  });

  it('refuses a name another label has in the same group, in any case, with CONFLICT on name', () => {
    expect(labelCreateProblem(teamLabels, ENG_SCOPE, { name: 'bug', isGroup: false })).toEqual({
      code: 'CONFLICT',
      field: 'name',
      message: 'A label named "bug" already exists in ENG. Choose another name.',
    });
    expect(
      labelCreateProblem(teamLabels, ENG_SCOPE, { name: 'SMALL', isGroup: false, group: size }),
    ).toMatchObject({ code: 'CONFLICT' });
  });

  it('allows the same name in another group, or in no group', () => {
    expect(
      labelCreateProblem(teamLabels, ENG_SCOPE, { name: 'Small', isGroup: false }),
    ).toBeUndefined();
  });

  it('names the workspace in a workspace clash', () => {
    const ws = [label({ name: 'Bug', teamId: null })];
    expect(labelCreateProblem(ws, WORKSPACE, { name: 'bug', isGroup: false })?.message).toBe(
      'A label named "bug" already exists in the workspace. Choose another name.',
    );
  });

  it('refuses separators and reserved words on name (E18, E19)', () => {
    expect(labelCreateProblem([], ENG_SCOPE, { name: 'a/b', isGroup: false })).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'name',
    });
    expect(labelCreateProblem([], ENG_SCOPE, { name: 'Priority', isGroup: true })?.message).toBe(
      'Priority is a reserved name. Choose another label name.',
    );
  });

  it('refuses exclusive on a plain label, a group inside a group, and a plain label as group', () => {
    expect(
      labelCreateProblem([], ENG_SCOPE, { name: 'X', isGroup: false, exclusive: false }),
    ).toMatchObject({ field: 'exclusive' });
    expect(
      labelCreateProblem(teamLabels, ENG_SCOPE, { name: 'X', isGroup: true, group: size }),
    ).toMatchObject({ field: 'group', message: "A label group can't go inside another group." });
    expect(
      labelCreateProblem(teamLabels, ENG_SCOPE, { name: 'X', isGroup: false, group: bug }),
    ).toMatchObject({ field: 'group' });
  });

  it('refuses a group of another scope, and an archived group (E14)', () => {
    const wsGroup = label({ name: 'Kind', isGroup: true, teamId: null });
    expect(
      labelCreateProblem([], ENG_SCOPE, { name: 'X', isGroup: false, group: wsGroup })?.message,
    ).toBe("Team labels can only go in their team's groups.");
    const archived = label({ name: 'Old', isGroup: true, archivedAt: '2026-11-01T00:00:00Z' });
    expect(
      labelCreateProblem([archived], ENG_SCOPE, { name: 'X', isGroup: false, group: archived })
        ?.message,
    ).toBe('The Old group is archived. Unarchive the group first.');
  });

  it('refuses the 501st label of a scope and the 251st of a group, archived ones counting (AC-13)', () => {
    const full = Array.from({ length: LABEL_LIMITS.perScope }, (_, i) =>
      label({ name: `L${i}`, archivedAt: i % 2 === 0 ? '2026-11-01T00:00:00Z' : null }),
    );
    expect(labelCreateProblem(full, ENG_SCOPE, { name: 'More', isGroup: false })).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'A team can have at most 500 labels. Delete one first.',
    });
    const inGroup = Array.from({ length: LABEL_LIMITS.perGroup }, (_, i) =>
      label({ name: `G${i}`, parentId: size.id }),
    );
    expect(
      labelCreateProblem([size, ...inGroup], ENG_SCOPE, {
        name: 'More',
        isGroup: false,
        group: size,
      })?.message,
    ).toBe('A label group can have at most 250 labels. Delete one first.');
  });
});

describe('labelUpdateProblem', () => {
  it('accepts a rename that keeps or changes the case of its own name', () => {
    expect(labelUpdateProblem(teamLabels, ENG_SCOPE, bug, { name: 'BUG' })).toBeUndefined();
  });

  it('refuses a name another label of the group has', () => {
    expect(labelUpdateProblem(teamLabels, ENG_SCOPE, bug, { name: 'size' })).toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('checks the name in the destination group when moving, and takes a label out with null', () => {
    const other = label({ name: 'Bug', parentId: size.id });
    expect(
      labelUpdateProblem([...teamLabels, other], ENG_SCOPE, bug, { group: size }),
    ).toMatchObject({ code: 'CONFLICT' });
    expect(labelUpdateProblem(teamLabels, ENG_SCOPE, small, { group: null })).toBeUndefined();
  });

  it('never reads issues: switching a group to single or moving into a group is a pure check (AC-10)', () => {
    expect(labelUpdateProblem(teamLabels, ENG_SCOPE, size, { exclusive: true })).toBeUndefined();
    expect(labelUpdateProblem(teamLabels, ENG_SCOPE, bug, { group: size })).toBeUndefined();
  });

  it('refuses exclusive on a plain label, and a group moved into a group', () => {
    expect(labelUpdateProblem(teamLabels, ENG_SCOPE, bug, { exclusive: false })).toMatchObject({
      field: 'exclusive',
    });
    const other = label({ name: 'Scope', isGroup: true });
    expect(
      labelUpdateProblem([...teamLabels, other], ENG_SCOPE, other, { group: size }),
    ).toMatchObject({ field: 'group' });
  });

  it('lets an archived label be renamed, and stay in its archived group (E14)', () => {
    const group = label({ name: 'Old', isGroup: true, archivedAt: '2026-11-01T00:00:00Z' });
    const inside = label({ name: 'Tiny', parentId: group.id, archivedAt: '2026-11-01T00:00:00Z' });
    const all = [group, inside];
    expect(labelUpdateProblem(all, ENG_SCOPE, inside, { name: 'Mini' })).toBeUndefined();
    expect(labelUpdateProblem(all, ENG_SCOPE, inside, { group })).toBeUndefined();
    expect(labelUpdateProblem([...all, bug], ENG_SCOPE, bug, { group })?.message).toBe(
      'The Old group is archived. Unarchive the group first.',
    );
  });
});

describe('labelDeleteProblem (AC-12)', () => {
  it('refuses a group that has labels, archived ones included, and allows an empty one', () => {
    expect(labelDeleteProblem(teamLabels, size)).toMatchObject({
      code: 'CONFLICT',
      message: 'The Size group still has labels. Delete them or take them out of the group first.',
    });
    const archivedChild = label({ name: 'Gone', parentId: size.id, archivedAt: '2026-11-01Z' });
    expect(labelDeleteProblem([size, archivedChild], size)).toMatchObject({ code: 'CONFLICT' });
    expect(labelDeleteProblem([size], size)).toBeUndefined();
    expect(labelDeleteProblem(teamLabels, bug)).toBeUndefined();
  });
});

describe('labelMovePlan (AC-24)', () => {
  it('moves one label, or a group with all its labels, archived included', () => {
    const archived = label({ name: 'Huge', parentId: size.id, archivedAt: '2026-11-01Z' });
    const all = [...teamLabels, archived];
    const one = labelMovePlan(all, [], bug);
    expect(one.ok && one.moving.map((l) => l.id)).toEqual([bug.id]);
    const group = labelMovePlan(all, [], size);
    expect(group.ok && group.moving.map((l) => l.name)).toEqual(['Size', 'Small', 'Huge']);
  });

  it('refuses a label inside a group (E21)', () => {
    expect(labelMovePlan(teamLabels, [], small)).toEqual({
      ok: false,
      problem: {
        code: 'INVALID_INPUT',
        field: 'label',
        message: 'Move the Size group instead, or take the label out of its group first.',
      },
    });
  });

  it('refuses a name a workspace label has, in any case (E20)', () => {
    const ws = [label({ name: 'bug', teamId: null })];
    expect(labelMovePlan(teamLabels, ws, bug)).toEqual({
      ok: false,
      problem: {
        code: 'CONFLICT',
        field: 'name',
        message: 'A workspace label named Bug already exists. Rename this label first.',
      },
    });
  });

  it('applies the workspace limit to everything that moves (AC-13)', () => {
    const ws = Array.from({ length: LABEL_LIMITS.perScope - 1 }, (_, i) =>
      label({ name: `W${i}`, teamId: null }),
    );
    expect(labelMovePlan(teamLabels, ws, bug).ok).toBe(true);
    const plan = labelMovePlan(teamLabels, ws, size);
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.problem.message).toBe(
      'The workspace can have at most 500 labels. Delete one first.',
    );
  });
});

describe('labelArchivePlan and labelUnarchivePlan (AC-11, D26, E14)', () => {
  const AT = '2026-11-12T10:00:00.000Z';
  const names = (plan: ReturnType<typeof labelArchivePlan>) =>
    plan.ok ? plan.changing.map((l) => l.name).sort() : plan.problem.message;

  it('archives a group with its labels, skipping rows already archived', () => {
    const group = label({ name: 'Size', isGroup: true });
    const all = [
      group,
      label({ name: 'Small', parentId: group.id }),
      label({ name: 'Old', parentId: group.id, archivedAt: AT }),
      label({ name: 'Other' }),
    ];
    expect(names(labelArchivePlan(all, group))).toEqual(['Size', 'Small']);
  });

  it('archives a label of a group alone, and an archived label changes nothing', () => {
    const group = label({ name: 'Size', isGroup: true });
    const small = label({ name: 'Small', parentId: group.id });
    expect(names(labelArchivePlan([group, small], small))).toEqual(['Small']);
    const old = label({ name: 'Old', archivedAt: AT });
    expect(names(labelArchivePlan([old], old))).toEqual([]);
  });

  it('unarchives a group with all its archived labels', () => {
    const group = label({ name: 'Size', isGroup: true, archivedAt: AT });
    const all = [group, label({ name: 'Small', parentId: group.id, archivedAt: AT })];
    expect(names(labelUnarchivePlan(all, group))).toEqual(['Size', 'Small']);
  });

  it('changes nothing when the named label is already in the wanted state, members included', () => {
    const live = label({ name: 'Area', isGroup: true });
    const web = label({ name: 'Web', parentId: live.id, archivedAt: AT });
    expect(names(labelUnarchivePlan([live, web], live))).toEqual([]);
    const old = label({ name: 'Size', isGroup: true, archivedAt: AT });
    const small = label({ name: 'Small', parentId: old.id });
    expect(names(labelArchivePlan([old, small], old))).toEqual([]);
  });

  it('refuses to unarchive a label whose group is archived (E14), and allows it when the group is live', () => {
    const group = label({ name: 'Size', isGroup: true, archivedAt: AT });
    const small = label({ name: 'Small', parentId: group.id, archivedAt: AT });
    expect(names(labelUnarchivePlan([group, small], small))).toBe(
      'The Size group is archived. Unarchive the group first.',
    );
    const live = label({ name: 'Area', isGroup: true });
    const web = label({ name: 'Web', parentId: live.id, archivedAt: AT });
    expect(names(labelUnarchivePlan([live, web], web))).toEqual(['Web']);
  });
});
