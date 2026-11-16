/**
 * Label rules (SPEC-010 §4.2, §6): names, groups, limits, the "New label" row's `Group/Label`
 * input, and the label-write rule that keeps one label per exclusive group (INV-07, D10, D20).
 * Pure functions, shared by the client's `optimistic` and the server's handlers, so both refuse
 * the same things with the same words.
 */
import { nameProblem } from './names.js';

/** At most 500 labels per scope and 250 per group, archived labels included (SPEC-010 D22). */
export const LABEL_LIMITS = { perScope: 500, perGroup: 250 } as const;
export const LABEL_NAME_MAX_LENGTH = 50;
export const LABEL_DESCRIPTION_MAX_LENGTH = 255;

/**
 * Filter keywords a label can't be named (SPEC-010 §4.2, E19), compared case-insensitively, so a
 * filter like `priority:` never means a label.
 */
export const RESERVED_LABEL_NAMES: readonly string[] = [
  'assignee',
  'cycle',
  'effort',
  'estimate',
  'hours',
  'priority',
  'project',
  'state',
  'status',
];

/** The characters that separate a group from a label (`Size/Small`, `Size:Small`, D19). */
const GROUP_SEPARATOR = /[/:]/;

/**
 * Why `name` can't be a label or group name, or undefined if it can (AC-9, E18, E19): 1–50
 * characters after trimming, no `/` or `:`, not a reserved word. Uniqueness within the scope
 * and group is checked by the handler under the scope lock.
 */
export function labelNameProblem(name: string): string | undefined {
  const length = nameProblem('Label name', name, LABEL_NAME_MAX_LENGTH);
  if (length !== undefined) return length;
  const trimmed = name.trim();
  if (GROUP_SEPARATOR.test(trimmed)) {
    return "Label names can't contain / or :. Use a group instead, like Size/Small.";
  }
  const lower = trimmed.toLowerCase();
  if (RESERVED_LABEL_NAMES.includes(lower)) {
    const word = lower.charAt(0).toUpperCase() + lower.slice(1);
    return `${word} is a reserved name. Choose another label name.`;
  }
  return undefined;
}

export type LabelScope = 'team' | 'workspace';

/**
 * Why one more label can't be created (or moved) into a scope that holds `inScope` labels and,
 * when it goes into a group, a group that holds `inGroup`; undefined if it can (AC-13). Counts
 * include archived labels and groups (D22).
 */
export function labelLimitProblem(
  scope: LabelScope,
  counts: { readonly inScope: number; readonly inGroup?: number },
): string | undefined {
  if (counts.inScope >= LABEL_LIMITS.perScope) {
    const owner = scope === 'team' ? 'A team' : 'The workspace';
    return `${owner} can have at most ${LABEL_LIMITS.perScope} labels. Delete one first.`;
  }
  if (counts.inGroup !== undefined && counts.inGroup >= LABEL_LIMITS.perGroup) {
    return `A label group can have at most ${LABEL_LIMITS.perGroup} labels. Delete one first.`;
  }
  return undefined;
}

export type ParsedLabelInput =
  | { readonly ok: true; readonly group: string | null; readonly name: string }
  | { readonly ok: false; readonly problem: string };

/**
 * What the settings "New label" row means by `text` (SPEC-010 §3.2, AC-25): `Group/Label` or
 * `Group:Label` is a label inside a group (spaces around the parts trimmed), anything else a
 * plain label. It splits at the first separator; the parts are then checked with
 * `labelNameProblem`, which refuses a second separator. Empty parts are an error.
 */
export function parseLabelInput(text: string): ParsedLabelInput {
  const match = GROUP_SEPARATOR.exec(text);
  if (match === null) {
    const name = text.trim();
    if (name === '') return { ok: false, problem: 'Label name is required' };
    return { ok: true, group: null, name };
  }
  const group = text.slice(0, match.index).trim();
  const name = text.slice(match.index + 1).trim();
  if (group === '' || name === '') {
    return { ok: false, problem: 'Type a group and a label, like Size/Small.' };
  }
  return { ok: true, group, name };
}

/** The fields of a label that the group rules read. */
export interface LabelGroupCandidate {
  readonly name: string;
  readonly teamId: string | null;
  readonly isGroup: boolean;
  readonly parentId: string | null;
  readonly archivedAt?: Date | string | null;
}

/**
 * Why `label` can't go into `group`, or undefined if it can (SPEC-010 §4.2, AC-9, E14): groups
 * are one level deep (a group goes in no group, and the target is a group with no parent), the
 * group is in the label's scope (the same team, or both workspace), and the group is live.
 */
export function labelGroupProblem(
  label: { readonly teamId: string | null; readonly isGroup: boolean },
  group: LabelGroupCandidate,
): string | undefined {
  if (label.isGroup) return "A label group can't go inside another group.";
  if (!group.isGroup || group.parentId !== null) {
    return `${group.name} is not a label group. Choose a group, or create one first.`;
  }
  if (label.teamId !== group.teamId) {
    return label.teamId === null
      ? 'Workspace labels can only go in workspace groups.'
      : "Team labels can only go in their team's groups.";
  }
  if (group.archivedAt != null) {
    return `The ${group.name} group is archived. Unarchive the group first.`;
  }
  return undefined;
}

/** What the label-write rule needs to know about a label or group. */
export interface LabelInfo {
  readonly parentId: string | null;
  /** Meaningful on groups only: single-select (SPEC-010 §4.2). */
  readonly exclusive: boolean;
}

/**
 * An issue's `labelIds` after adding `added` to `current` (SPEC-010 §4.2, AC-10; SPEC-011 §4.2
 * calls it, after its own validation). Adding a label of an **exclusive** group G removes the
 * issue's other labels of G in the same write; a multi-select group removes nothing. A label the
 * issue already has is a no-op, so it removes nothing either: an issue that carries two labels of
 * an exclusive G keeps both until a write newly adds a label of G (D20, E6). When one write adds
 * several labels of one exclusive group, the last one wins. Labels not in `labels` (unknown or
 * deleted) are kept as they are and belong to no group. Order: the kept current labels, then the
 * new ones in the order given.
 */
export function applyLabelAdd(
  labels: ReadonlyMap<string, LabelInfo>,
  current: readonly string[],
  added: readonly string[],
): string[] {
  const exclusiveGroupOf = (id: string): string | undefined => {
    const parentId = labels.get(id)?.parentId;
    if (parentId == null) return undefined;
    return labels.get(parentId)?.exclusive === true ? parentId : undefined;
  };
  const had = new Set(current);
  let result = [...had];
  for (const id of added) {
    // Already on the issue before this write (even if an earlier add here replaced it), or
    // already added: a no-op (SPEC-011 §4.2).
    if (had.has(id) || result.includes(id)) continue;
    const group = exclusiveGroupOf(id);
    if (group !== undefined) result = result.filter((other) => exclusiveGroupOf(other) !== group);
    result.push(id);
  }
  return result;
}

/**
 * The labels an issue shows: those of `issue.labelIds` that `lookup` knows, by name (then id).
 * A label deleted on the server leaves its id in `labelIds` until the cascade's deltas arrive, and
 * `label.delete`'s prediction removes only the Label row, so every renderer and picker skips an
 * id the store doesn't hold (SPEC-010 §5, AC-17; SPEC-012 §3.5). The one shared rule.
 */
export function labelsOf<L extends { readonly id: string; readonly name: string }>(
  issue: { readonly labelIds: readonly string[] },
  lookup: (id: string) => L | undefined,
): L[] {
  return issue.labelIds
    .flatMap((id) => {
      const label = lookup(id);
      return label === undefined ? [] : [label];
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en'));
}
