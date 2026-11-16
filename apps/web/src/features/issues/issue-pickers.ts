// What a bound picker offers and sends for one issue (SPEC-012 §3.5; PLAN-012 S6). Pure: the
// page's pills, the row's pills and menu, the `S P A L Shift+E Shift+D` keys and the command
// menu's property commands all ask here, so they offer the same options and send the same
// `issue.update`. Option lists come from `picker-options.ts`; this module adds what the issue
// itself holds (the current value) and the partial input for a choice.
import { lifecycleOf, type IssueLifecycle } from '@surface/domain';
import { Issue } from '@surface/domain/model';
import type { InputOf, issueUpdate } from '@surface/operations';
import type { ReadonlyPool } from '@surface/sync-client';
import type { PropertyPickerOption } from '@surface/ui';
import type { ComposerWorld } from './composer-model.js';
import {
  assigneeOptions,
  estimateOptions,
  labelChange,
  labelOptions,
  NONE,
  priorityOptions,
  statusOptions,
} from './picker-options.js';

export const PICKER_KINDS = [
  'status',
  'priority',
  'assignee',
  'labels',
  'estimate',
  'dueDate',
] as const;
export type PickerKind = (typeof PICKER_KINDS)[number];

export type IssueUpdateInput = InputOf<typeof issueUpdate>;

/** What a picker reads of an issue in the replica. */
export interface IssueFacts {
  readonly id: string;
  readonly teamId: string;
  readonly number: number | null;
  readonly title: string;
  readonly statusId: string;
  readonly priority: number;
  readonly assigneeId: string | null;
  readonly labelIds: readonly string[];
  readonly estimate: number | null;
  readonly dueDate: string | null;
  readonly lifecycle: IssueLifecycle;
}

/** The issue as the replica holds it; undefined for one it doesn't (archived, deleted, unloaded). */
export function readIssueFacts(pool: ReadonlyPool, id: string): IssueFacts | undefined {
  const issue = pool.get(Issue, id);
  if (issue === undefined) return undefined;
  return {
    id: issue.id,
    teamId: issue.teamId,
    number: issue.number,
    title: issue.title,
    statusId: issue.statusId,
    priority: issue.priority,
    assigneeId: issue.assigneeId,
    labelIds: issue.labelIds,
    estimate: issue.estimate,
    dueDate: issue.dueDate,
    lifecycle: lifecycleOf(issue),
  };
}

/** "ENG-42 is archived. Restore it to edit it." (SPEC-012 §3.8); undefined for a live issue. */
export function lifecycleReason(identifier: string, lifecycle: IssueLifecycle): string | undefined {
  if (lifecycle === 'archived') return `${identifier} is archived. Restore it to edit it.`;
  if (lifecycle === 'deleted') return `${identifier} was deleted. Restore it to edit it.`;
  return undefined;
}

export type PickerSpec =
  | {
      readonly kind: 'status' | 'priority' | 'assignee' | 'estimate';
      readonly mode: 'single';
      readonly label: string;
      readonly value: string | null;
      readonly options: PropertyPickerOption[];
    }
  | {
      readonly kind: 'labels';
      readonly mode: 'multi';
      readonly label: string;
      readonly values: readonly string[];
      readonly options: PropertyPickerOption[];
    }
  | { readonly kind: 'dueDate'; readonly mode: 'date'; readonly label: string };

/**
 * The picker for `kind` on `facts`, or undefined when it has nothing to offer: the team is gone
 * from the replica, or an estimate picker on a team that doesn't use estimates.
 */
export function pickerSpec(
  kind: PickerKind,
  world: ComposerWorld,
  facts: IssueFacts,
): PickerSpec | undefined {
  const team = world.teams.find((t) => t.id === facts.teamId);
  if (team === undefined) return undefined;
  switch (kind) {
    case 'status':
      return {
        kind,
        mode: 'single',
        label: 'Change status',
        value: facts.statusId,
        options: statusOptions(world.statuses, team.id),
      };
    case 'priority':
      return {
        kind,
        mode: 'single',
        label: 'Set priority',
        value: String(facts.priority),
        options: priorityOptions(),
      };
    case 'assignee':
      return {
        kind,
        mode: 'single',
        label: 'Assign to',
        value: facts.assigneeId ?? NONE,
        options: assigneeOptions(world.users, team, world.members[team.id] ?? [], world.me),
      };
    case 'labels':
      return {
        kind,
        mode: 'multi',
        label: 'Change labels',
        values: facts.labelIds,
        options: labelOptions(world.labels, team.id, facts.labelIds),
      };
    case 'estimate': {
      const options = estimateOptions(team.estimate);
      if (options.length === 0) return undefined;
      return {
        kind,
        mode: 'single',
        label: 'Set estimate',
        value: facts.estimate === null ? NONE : String(facts.estimate),
        options,
      };
    }
    case 'dueDate':
      return { kind, mode: 'date', label: 'Set due date' };
  }
}

/**
 * The `issue.update` for choosing option `id` in a single-value picker; undefined when the choice
 * is the current value (a change to nothing writes nothing) or not a number where one is needed.
 */
export function singleInput(
  kind: 'status' | 'priority' | 'assignee' | 'estimate',
  facts: IssueFacts,
  id: string,
): IssueUpdateInput | undefined {
  const issue = facts.id;
  switch (kind) {
    case 'status':
      return id === facts.statusId ? undefined : { issue, status: id };
    case 'priority': {
      const priority = Number(id);
      return Number.isInteger(priority) && priority !== facts.priority
        ? { issue, priority }
        : undefined;
    }
    case 'assignee': {
      const assignee = id === NONE ? null : id;
      return assignee === facts.assigneeId ? undefined : { issue, assignee };
    }
    case 'estimate': {
      const estimate = id === NONE ? null : Number(id);
      if (estimate !== null && !Number.isFinite(estimate)) return undefined;
      return estimate === facts.estimate ? undefined : { issue, estimate };
    }
  }
}

/**
 * One `issue.update` with the user's toggles: the difference between the labels the picker opened
 * with and the ones it closed with, applied to the issue as it is now. A label another client
 * added or removed while the picker was open is not the user's toggle, so it survives.
 */
export function labelsInput(
  facts: IssueFacts,
  opened: readonly string[],
  chosen: readonly string[],
): IssueUpdateInput | undefined {
  const toggles = labelChange(opened, chosen);
  if (toggles === undefined) return undefined;
  // Adding what is already there, or removing what is already gone, changes nothing.
  const addLabels = toggles.addLabels?.filter((id) => !facts.labelIds.includes(id)) ?? [];
  const removeLabels = toggles.removeLabels?.filter((id) => facts.labelIds.includes(id)) ?? [];
  const change = {
    ...(addLabels.length === 0 ? {} : { addLabels }),
    ...(removeLabels.length === 0 ? {} : { removeLabels }),
  };
  return addLabels.length === 0 && removeLabels.length === 0
    ? undefined
    : { issue: facts.id, ...change };
}

export function dueDateInput(
  facts: IssueFacts,
  dueDate: string | null,
): IssueUpdateInput | undefined {
  return dueDate === facts.dueDate ? undefined : { issue: facts.id, dueDate };
}

/** Assign to me (`I`): undefined when it is already mine, or when the team doesn't offer "Me". */
export function assignToMeInput(
  world: ComposerWorld,
  facts: IssueFacts,
): IssueUpdateInput | undefined {
  if (facts.assigneeId === world.me) return undefined;
  const spec = pickerSpec('assignee', world, facts);
  if (spec?.mode !== 'single' || !spec.options.some((option) => option.id === world.me)) {
    return undefined;
  }
  return { issue: facts.id, assignee: world.me };
}
