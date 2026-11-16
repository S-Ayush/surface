// The options each property picker offers (SPEC-012 §3.5), computed once so the composer, and in
// S6 the issue page, the row and the command menu, offer the same ones. Pure: icons are added by
// the component from the ids. PLAN-012 S5 ships this first version for the composer's pills; S6
// finishes it for the bound pickers.
import {
  estimateValues,
  formatEstimate,
  issueStatusProblem,
  PRIORITIES,
  STATUS_CATEGORIES,
  type EstimateConfig,
} from '@surface/domain';
import type { PropertyPickerOption as PickerOption } from '@surface/ui';
import type {
  ComposerLabel,
  ComposerStatus,
  ComposerTeam,
  ComposerUser,
} from './composer-model.js';

/**
 * The labels to add and remove to go from `before` to `after` (SPEC-012 §3.5): one
 * `issue.update` with the difference, or undefined when nothing changed. Order never matters.
 */
export function labelChange(
  before: readonly string[],
  after: readonly string[],
): { readonly addLabels?: string[]; readonly removeLabels?: string[] } | undefined {
  const addLabels = after.filter((id) => !before.includes(id));
  const removeLabels = before.filter((id) => !after.includes(id));
  if (addLabels.length === 0 && removeLabels.length === 0) return undefined;
  return {
    ...(addLabels.length === 0 ? {} : { addLabels }),
    ...(removeLabels.length === 0 ? {} : { removeLabels }),
  };
}

/** `Shift+E` on a team whose scale is `off` (SPEC-012 §3.5): the hint instead of a picker. */
export const estimatesOffMessage = (teamKey: string) =>
  `${teamKey} doesn't use estimates. Turn them on in team settings.`;

/** The id of the "none" option in single-value pickers that allow no value. */
export const NONE = '__none__';

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The team's statuses in workflow order, Triage and Duplicate left out; `1`–`9` by position. */
export function statusOptions(statuses: readonly ComposerStatus[], teamId: string): PickerOption[] {
  return statuses
    .filter((s) => s.teamId === teamId && issueStatusProblem(s.category) === undefined)
    .sort(
      (a, b) =>
        STATUS_CATEGORIES.indexOf(a.category) - STATUS_CATEGORIES.indexOf(b.category) ||
        byText(a.position, b.position) ||
        byText(a.id, b.id),
    )
    .map((s, index) => ({
      id: s.id,
      label: s.name,
      ...(index < 9 ? { quickKey: String(index + 1) } : {}),
    }));
}

/** No priority, Urgent, High, Medium, Low with `0`–`4`. Ids are the numbers as text. */
export function priorityOptions(): PickerOption[] {
  return PRIORITIES.map((p) => ({
    id: String(p.value),
    label: p.label,
    quickKey: String(p.value),
  }));
}

/**
 * "No assignee", **Me**, the team's members, then (public teams only) the other active users, by
 * name. A private team offers only its members (SPEC-011: the assignee must see the team).
 */
export function assigneeOptions(
  users: readonly ComposerUser[],
  team: ComposerTeam,
  members: readonly string[],
  me: string,
): PickerOption[] {
  const keywords = (u: ComposerUser) => `${u.displayName} ${u.email}`;
  const active = users.filter((u) => u.active);
  const self = active.find((u) => u.id === me && (!team.private || members.includes(me)));
  const sorted = (list: readonly ComposerUser[]) =>
    [...list].sort((a, b) => a.name.localeCompare(b.name) || byText(a.id, b.id));
  const inTeam = sorted(active.filter((u) => u.id !== me && members.includes(u.id)));
  const others = team.private
    ? []
    : sorted(active.filter((u) => u.id !== me && !members.includes(u.id)));
  return [
    { id: NONE, label: 'No assignee' },
    ...(self === undefined
      ? []
      : [{ id: self.id, label: 'Me', keywords: `${self.name} ${keywords(self)}` }]),
    ...[...inTeam, ...others].map((u) => ({ id: u.id, label: u.name, keywords: keywords(u) })),
  ];
}

/**
 * Team labels, then workspace labels, each under its group's name. Archived labels only when
 * applied; groups themselves aren't options; a group's labels are exclusive when the group is.
 */
export function labelOptions(
  labels: readonly ComposerLabel[],
  teamId: string,
  applied: readonly string[],
): PickerOption[] {
  const groups = new Map(labels.filter((l) => l.isGroup).map((l) => [l.id, l]));
  const usable = labels.filter(
    (l) =>
      !l.isGroup &&
      (l.teamId === null || l.teamId === teamId) &&
      (!l.archived || applied.includes(l.id)),
  );
  const rank = (l: ComposerLabel) => (l.teamId === null ? 1 : 0);
  return usable
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || byText(a.id, b.id))
    .map((l) => {
      const group = l.parentId === null ? undefined : groups.get(l.parentId);
      return {
        id: l.id,
        label: l.name,
        ...(group === undefined ? {} : { group: group.name }),
        ...(group?.exclusive === true ? { exclusiveGroup: group.id } : {}),
      };
    });
}

/**
 * "No estimate" (`0`), then the scale's values with their labels; a digit equal to a value picks
 * it (fibonacci `5` → 5, t-shirt `5` → L). Empty while the scale is `off` (the pill is hidden).
 */
export function estimateOptions(config: EstimateConfig): PickerOption[] {
  const values = estimateValues(config);
  if (values.length === 0) return [];
  return [
    { id: NONE, label: 'No estimate', quickKey: '0' },
    ...values.map((value) => ({
      id: String(value),
      label: formatEstimate(config, value),
      ...(value > 0 && value <= 9 ? { quickKey: String(value) } : {}),
    })),
  ];
}
