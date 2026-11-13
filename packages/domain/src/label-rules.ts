/**
 * What the label operations refuse, as pure functions of the labels in a scope (SPEC-010 §4.2,
 * §6, E14, E18–E21). The server's handlers call them under the scope lock and the client's
 * `optimistic` calls them on the replica, so both refuse the same things in the same words
 * (AC-16). Uniqueness is the scope, the parent and the name, case-insensitive, archived labels
 * included, like the database's `labels_scope_parent_name_idx`.
 */
import {
  labelGroupProblem,
  labelLimitProblem,
  labelNameProblem,
  type LabelGroupCandidate,
} from './label.js';

/** The fields of a label row the rules read. */
export interface LabelFacts extends LabelGroupCandidate {
  readonly id: string;
  readonly exclusive: boolean;
}

export interface LabelProblem {
  readonly code: 'INVALID_INPUT' | 'CONFLICT';
  /** The input field the message is about. */
  readonly field: string;
  readonly message: string;
}

/** Where a scope's labels live: a team (by key, for messages) or the workspace. */
export interface LabelScopeInfo {
  readonly teamId: string | null;
  readonly teamKey: string | null;
}

const NO_PARENT = '';

function invalid(field: string, message: string): LabelProblem {
  return { code: 'INVALID_INPUT', field, message };
}

function scopeWords(scope: LabelScopeInfo): string {
  return scope.teamKey === null ? 'the workspace' : scope.teamKey;
}

/** `CONFLICT` when another label of the scope has `name` under `parentId`. */
export function labelNameClash(
  labels: readonly LabelFacts[],
  scope: LabelScopeInfo,
  name: string,
  parentId: string | null,
  exceptIds: readonly string[] = [],
): LabelProblem | undefined {
  const lower = name.trim().toLowerCase();
  const taken = labels.some(
    (l) =>
      !exceptIds.includes(l.id) &&
      (l.parentId ?? NO_PARENT) === (parentId ?? NO_PARENT) &&
      l.name.toLowerCase() === lower,
  );
  if (!taken) return undefined;
  return {
    code: 'CONFLICT',
    field: 'name',
    message: `A label named "${name.trim()}" already exists in ${scopeWords(scope)}. Choose another name.`,
  };
}

const EXCLUSIVE_ONLY_ON_GROUPS =
  'Only a label group can be single or multiple choice. Set the group type on a group.';

export interface LabelCreateInput {
  readonly name: string;
  readonly isGroup: boolean;
  readonly exclusive?: boolean | undefined;
  /** The resolved group, when the label goes into one. */
  readonly group?: LabelFacts | undefined;
}

/**
 * Why a label can't be created in a scope that holds `labels` (archived included), or undefined
 * (AC-9, AC-13, E14, E18, E19). The order: name, group type, group, uniqueness, limits.
 */
export function labelCreateProblem(
  labels: readonly LabelFacts[],
  scope: LabelScopeInfo,
  input: LabelCreateInput,
): LabelProblem | undefined {
  const name = labelNameProblem(input.name);
  if (name !== undefined) return invalid('name', name);
  if (input.exclusive !== undefined && !input.isGroup) {
    return invalid('exclusive', EXCLUSIVE_ONLY_ON_GROUPS);
  }
  if (input.group !== undefined) {
    const group = labelGroupProblem({ teamId: scope.teamId, isGroup: input.isGroup }, input.group);
    if (group !== undefined) return invalid('group', group);
  }
  const clash = labelNameClash(labels, scope, input.name, input.group?.id ?? null);
  if (clash !== undefined) return clash;
  const limit = labelLimitProblem(scope.teamId === null ? 'workspace' : 'team', {
    inScope: labels.length,
    ...(input.group === undefined
      ? {}
      : { inGroup: labels.filter((l) => l.parentId === input.group?.id).length }),
  });
  return limit === undefined ? undefined : invalid('group', limit);
}

export interface LabelUpdateInput {
  readonly name?: string | undefined;
  readonly exclusive?: boolean | undefined;
  /** `undefined` leaves the group alone, `null` takes the label out of its group. */
  readonly group?: LabelFacts | null | undefined;
}

/**
 * Why `label` can't take `changes`, or undefined (AC-9, E14, E18, E19). Renaming and recoloring
 * work on archived labels too. Moving into a group, or switching a group to single, reads no
 * issue (AC-10).
 */
export function labelUpdateProblem(
  labels: readonly LabelFacts[],
  scope: LabelScopeInfo,
  label: LabelFacts,
  changes: LabelUpdateInput,
): LabelProblem | undefined {
  if (changes.name !== undefined) {
    const name = labelNameProblem(changes.name);
    if (name !== undefined) return invalid('name', name);
  }
  if (changes.exclusive !== undefined && !label.isGroup) {
    return invalid('exclusive', EXCLUSIVE_ONLY_ON_GROUPS);
  }
  const target = changes.group ?? undefined;
  // Staying in the group it is in is no move: an archived group still holds its labels.
  if (target !== undefined && target.id !== label.parentId) {
    const group = labelGroupProblem(label, target);
    if (group !== undefined) return invalid('group', group);
  }
  const parentId = changes.group === undefined ? label.parentId : (changes.group?.id ?? null);
  const name = changes.name?.trim() ?? label.name;
  const moved = parentId !== label.parentId;
  if (moved || name.toLowerCase() !== label.name.toLowerCase()) {
    const clash = labelNameClash(labels, scope, name, parentId, [label.id]);
    if (clash !== undefined) return clash;
  }
  if (moved && target !== undefined) {
    const limit = labelLimitProblem(scope.teamId === null ? 'workspace' : 'team', {
      inScope: 0,
      inGroup: labels.filter((l) => l.parentId === target.id).length,
    });
    if (limit !== undefined) return invalid('group', limit);
  }
  return undefined;
}

/** A group that still has labels can't be deleted (AC-12). Archived labels count. */
export function labelDeleteProblem(
  labels: readonly LabelFacts[],
  label: LabelFacts,
): LabelProblem | undefined {
  if (!label.isGroup || !labels.some((l) => l.parentId === label.id)) return undefined;
  return {
    code: 'CONFLICT',
    field: 'label',
    message: `The ${label.name} group still has labels. Delete them or take them out of the group first.`,
  };
}

export type LabelMovePlan =
  | { readonly ok: true; readonly moving: readonly LabelFacts[] }
  | { readonly ok: false; readonly problem: LabelProblem };

/**
 * What `label.moveToWorkspace` moves, or why it can't (AC-24, E20, E21): the label, or a group
 * and all its labels, archived ones included. A label inside a group can't move alone. The name
 * must be free among workspace labels with no parent (the labels in a group keep their group),
 * and the workspace limits apply.
 */
export function labelMovePlan(
  teamLabels: readonly LabelFacts[],
  workspaceLabels: readonly LabelFacts[],
  label: LabelFacts,
): LabelMovePlan {
  if (label.parentId !== null) {
    const group = teamLabels.find((l) => l.id === label.parentId)?.name ?? 'label';
    return {
      ok: false,
      problem: invalid(
        'label',
        `Move the ${group} group instead, or take the label out of its group first.`,
      ),
    };
  }
  const moving = label.isGroup
    ? [label, ...teamLabels.filter((l) => l.parentId === label.id)]
    : [label];
  const lower = label.name.toLowerCase();
  if (workspaceLabels.some((l) => l.parentId === null && l.name.toLowerCase() === lower)) {
    return {
      ok: false,
      problem: {
        code: 'CONFLICT',
        field: 'name',
        message: `A workspace label named ${label.name} already exists. Rename this label first.`,
      },
    };
  }
  const limit = labelLimitProblem('workspace', {
    inScope: workspaceLabels.length + moving.length - 1,
  });
  return limit === undefined
    ? { ok: true, moving }
    : { ok: false, problem: invalid('label', limit) };
}
