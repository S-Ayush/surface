// The labels pages' model (SPEC-010 §3.2), pure: the table of a scope's labels and groups sorted by
// name, the filter, the footer count, who may edit, and what the "New label" row turns its text
// into (`Group/Label`, AC-25). The rules (names, groups, limits) are the domain's, shared with the
// server and the operations' `optimistic`, so the page refuses what the server refuses.
import {
  bindPredicates,
  labelCreateProblem,
  parseLabelInput,
  type Actor,
  type ColorHue,
  type LabelFacts,
  type LabelScopeInfo,
  type ResolvedRefs,
} from '@surface/domain';
import { labelCreate, labelDelete, labelMoveToWorkspace, labelUpdate } from '@surface/operations';
import { formatCreated } from '../issues/list-model.js';

export type LabelItem = {
  readonly id: string;
  readonly teamId: string | null;
  readonly name: string;
  readonly color: ColorHue;
  readonly description: string | null;
  readonly parentId: string | null;
  readonly isGroup: boolean;
  /** Groups only: single-select. */
  readonly exclusive: boolean;
  readonly archived: boolean;
  /** Set on an archived label of a live group when the Archived section lists it on its own. */
  readonly groupName?: string;
  readonly createdAt: string;
};

/** The page's scope: one team's labels, or the workspace's. */
export type LabelsScope =
  | { readonly kind: 'team'; readonly teamId: string; readonly teamKey: string }
  | { readonly kind: 'workspace' };

export function scopeInfo(scope: LabelsScope): LabelScopeInfo {
  return scope.kind === 'team'
    ? { teamId: scope.teamId, teamKey: scope.teamKey }
    : { teamId: null, teamKey: null };
}

/** The live labels of the scope: the table's rows. Archived ones are `archivedEntries`. */
export function scopeLabels(all: readonly LabelItem[], scope: LabelsScope): LabelItem[] {
  const teamId = scope.kind === 'team' ? scope.teamId : null;
  return all.filter((label) => label.teamId === teamId && !label.archived);
}

/** Every label of the scope, archived included: what the uniqueness and limits count (D22). */
export function allInScope(all: readonly LabelItem[], scope: LabelsScope): LabelItem[] {
  const teamId = scope.kind === 'team' ? scope.teamId : null;
  return all.filter((label) => label.teamId === teamId);
}

/**
 * The "Archived" section's entries (§3.2, PLAN-010 S6): archived groups with their archived
 * labels, and archived labels of a live group as plain entries (their group isn't in the section).
 */
export function archivedEntries(items: readonly LabelItem[], filter: string): LabelEntry[] {
  const archived = items.filter((l) => l.archived);
  const ids = new Set(archived.filter((l) => l.isGroup).map((l) => l.id));
  const flat = archived.map((l) => {
    if (l.parentId === null || ids.has(l.parentId)) return l;
    // Its group is live, so it stands alone here: name the group so two "Small" differ.
    const group = items.find((g) => g.id === l.parentId);
    return { ...l, parentId: null, ...(group === undefined ? {} : { groupName: group.name }) };
  });
  return labelEntries(flat, filter);
}

function byName(a: LabelItem, b: LabelItem): number {
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.id < b.id ? -1 : 1);
}

export type LabelEntry = {
  readonly label: LabelItem;
  /** The labels of a group, by name; empty for a plain label. */
  readonly children: readonly LabelItem[];
};

/**
 * The table's entries: groups (with their labels) and plain labels, sorted by name, any case.
 * `filter` keeps a plain label whose name contains it, a group whose own name does (with all its
 * labels), and a group with a matching label (with the matching labels only).
 */
export function labelEntries(items: readonly LabelItem[], filter: string): LabelEntry[] {
  const wanted = filter.trim().toLowerCase();
  const matches = (label: LabelItem) => label.name.toLowerCase().includes(wanted);
  const children = (group: LabelItem) => items.filter((l) => l.parentId === group.id).sort(byName);
  const entries: LabelEntry[] = [];
  for (const label of items.filter((l) => l.parentId === null).sort(byName)) {
    if (!label.isGroup) {
      if (matches(label)) entries.push({ label, children: [] });
      continue;
    }
    const all = children(label);
    const shown = matches(label) ? all : all.filter(matches);
    if (matches(label) || shown.length > 0) entries.push({ label, children: shown });
  }
  return entries;
}

/** "N labels inherited from workspace" (§3.2): the workspace's labels, not its groups. */
export function inheritedCount(all: readonly LabelItem[]): number {
  return all.filter((l) => l.teamId === null && !l.isGroup && !l.archived).length;
}

export function inheritedText(count: number): string {
  return `${count} ${count === 1 ? 'label' : 'labels'} inherited from workspace`;
}

export type LabelsAccess = {
  /** Create, edit, move into groups and delete: the operations' own permission. */
  readonly edit: boolean;
  /** "Move to workspace…": a team label's, never offered on a workspace page. */
  readonly move: boolean;
};

/**
 * Runs the label operations' permission predicates on the actor, as the command menu's pre-check
 * does, so the page and the server agree on who may act. The server still decides.
 */
export function labelsAccess(actor: Actor | null, scope: LabelsScope): LabelsAccess {
  if (actor === null) return { edit: false, move: false };
  const { p } = bindPredicates(actor);
  // No catch: a check that fails must not read as allowed. These predicates need no input.
  const allows = (permission: (refs: ResolvedRefs) => boolean, refs: ResolvedRefs) =>
    permission(refs);
  const team = scope.kind === 'team' ? { id: scope.teamId } : undefined;
  const label = { id: 'label', teamId: team?.id ?? null };
  const refs: ResolvedRefs = team === undefined ? { label } : { team, label };
  const edit =
    allows((r) => labelCreate.permission(p, r, { name: 'x' }), refs) &&
    allows((r) => labelUpdate.permission(p, r, { label: 'x' }), refs) &&
    allows((r) => labelDelete.permission(p, r, { label: 'x' }), refs);
  return {
    edit,
    move:
      scope.kind === 'team' &&
      allows((r) => labelMoveToWorkspace.permission(p, r, { label: 'x', team: 'x' }), refs),
  };
}

function factsOf(label: LabelItem): LabelFacts {
  return {
    id: label.id,
    name: label.name,
    teamId: label.teamId,
    parentId: label.parentId,
    isGroup: label.isGroup,
    exclusive: label.exclusive,
    archivedAt: label.archived ? 'archived' : null,
  };
}

/** One operation the "New label" row dispatches. `group` is the id of the group it goes in. */
export type NewLabelStep = {
  readonly id: string;
  readonly name: string;
  readonly isGroup: boolean;
  readonly group?: string;
};

export type NewLabelPlan =
  | { readonly ok: true; readonly steps: readonly NewLabelStep[] }
  | { readonly ok: false; readonly problem: string };

/**
 * What the "New label" row's text makes (§3.2, AC-25): a plain name is one label; `Group/Label` or
 * `Group:Label` is the label inside its group, preceded by the group (single-select) when it does
 * not exist yet. Each step is checked with the server's rules against the scope's labels, so the
 * row shows the refusal before anything is sent. `newId` gives each created row its UUIDv7.
 */
export function planNewLabel(
  text: string,
  existing: readonly LabelItem[],
  scope: LabelsScope,
  newId: () => string,
  groupOverride?: LabelItem,
): NewLabelPlan {
  const parsed = parseLabelInput(text);
  if (!parsed.ok) return { ok: false, problem: parsed.problem };
  const info = scopeInfo(scope);
  const facts = existing.map(factsOf);
  const lowerGroup = parsed.group?.toLowerCase();
  const found =
    groupOverride ??
    (lowerGroup === undefined
      ? undefined
      : existing.find(
          (l) => l.isGroup && l.parentId === null && l.name.toLowerCase() === lowerGroup,
        ));
  const steps: NewLabelStep[] = [];
  let group: LabelFacts | undefined = found && factsOf(found);
  if (parsed.group !== null && group === undefined) {
    const id = newId();
    const problem = labelCreateProblem(facts, info, { name: parsed.group, isGroup: true });
    if (problem !== undefined) return { ok: false, problem: problem.message };
    steps.push({ id, name: parsed.group, isGroup: true });
    group = {
      id,
      name: parsed.group,
      teamId: info.teamId,
      parentId: null,
      isGroup: true,
      exclusive: true,
      archivedAt: null,
    };
    facts.push(group);
  }
  const problem = labelCreateProblem(facts, info, { name: parsed.name, isGroup: false, group });
  if (problem !== undefined) return { ok: false, problem: problem.message };
  steps.push({
    id: newId(),
    name: parsed.name,
    isGroup: false,
    ...(group === undefined ? {} : { group: group.id }),
  });
  return { ok: true, steps };
}

/** The "New group" row's one step: a group, single-select by default, checked like the server does. */
export function planNewGroup(
  name: string,
  existing: readonly LabelItem[],
  scope: LabelsScope,
  newId: () => string,
): NewLabelPlan {
  const trimmed = name.trim();
  const problem = labelCreateProblem(existing.map(factsOf), scopeInfo(scope), {
    name: trimmed,
    isGroup: true,
  });
  if (problem !== undefined) return { ok: false, problem: problem.message };
  return { ok: true, steps: [{ id: newId(), name: trimmed, isGroup: true }] };
}

/**
 * The groups a label can move into: live groups of its scope (§3.2), by name, plus the group it
 * is in now (`current`) even when archived, as a selected value (§4.2).
 */
export function groupChoices(items: readonly LabelItem[], current?: string | null): LabelItem[] {
  return items
    .filter((l) => l.isGroup && l.parentId === null && (!l.archived || l.id === current))
    .sort(byName);
}

const LONG_DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'long' });

/** The full day ("November 25, 2026", the viewer's zone) of a date, or undefined: the cell's tooltip. */
export function fullDayText(iso: string | null | undefined): string | undefined {
  if (iso === null || iso === undefined) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : LONG_DAY.format(date);
}

/** The text of a date as the table shows it, like the issue list's: "Nov 25", or "—". */
export function dayText(iso: string | null | undefined, now: Date = new Date()): string {
  if (iso === null || iso === undefined || iso.length < 10) return '—';
  return formatCreated(iso, String(now.getFullYear())) || '—';
}

/** One label's `label.usage` answer (SPEC-010 §5, D15). */
export interface LabelUsage {
  readonly issues: number;
  readonly teams: readonly { readonly key: string }[];
  readonly lastAppliedAt: string | null;
}

/** The usage columns of a row: Used in, Issues and Last applied. */
export interface UsageColumns {
  readonly usedIn: string;
  readonly issues: string;
  readonly lastApplied: string;
  /** The full day, for the cell's tooltip. */
  readonly lastAppliedFull?: string | undefined;
}

/** Until `label.usage` answers, and offline, every usage column is "—" (§3.2). */
export const UNKNOWN_USAGE: UsageColumns = { usedIn: '—', issues: '—', lastApplied: '—' };

/**
 * The usage columns from the server's answer: the teams of the label's issues by key, the count,
 * and the day of the latest update among them. A label no visible issue carries shows nothing in
 * Used in and Last applied, and 0 issues.
 */
export function usageColumns(usage: LabelUsage | undefined): UsageColumns {
  if (usage === undefined) return UNKNOWN_USAGE;
  return {
    usedIn: usage.teams.map((t) => t.key).join(', '),
    issues: String(usage.issues),
    lastApplied: usage.lastAppliedAt === null ? '' : dayText(usage.lastAppliedAt),
    lastAppliedFull: fullDayText(usage.lastAppliedAt),
  };
}

/**
 * The delete dialog's sentence (§3.2 item 7): N is the label's Issues count from `label.usage`,
 * so it counts only issues the actor can see; without it (offline, not answered yet) the count is
 * left out.
 */
export function deleteLabelText(issues: number | undefined): string {
  if (issues === undefined) {
    return "It will be removed from every issue that has it. This can't be undone.";
  }
  return `It will be removed from ${issues} ${issues === 1 ? 'issue' : 'issues'}. This can't be undone.`;
}
