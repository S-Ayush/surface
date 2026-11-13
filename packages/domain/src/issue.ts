/**
 * Issue field rules (SPEC-011 §4.1). Pure functions, shared by the client's `optimistic` and the
 * server's handlers (PLAN-011 S4), so both refuse the same things with the same words.
 */
import { estimateValues, isValidEstimate, type EstimateConfig } from './estimate.js';
import { defineFilterFields } from './filter/fields.js';
import { foldToSlug } from './git-branch.js';
import { applyLabelAdd, type LabelInfo } from './label.js';
import { PRIORITIES, type Priority } from './priority.js';
import { STATUS_CATEGORIES, type StatusCategory } from './status-category.js';
import type { EstimateScale } from './workspace.js';

export const ISSUE_TITLE_MAX_LENGTH = 255;

/** Line breaks of every kind (CRLF first, so it becomes one space, not two). */
const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029]/g;

/**
 * The title as stored: line breaks replaced by spaces (Q5), surrounding spaces trimmed. Spaces
 * inside are kept as typed.
 */
export function normalizeTitle(title: string): string {
  return title.replace(LINE_BREAKS, ' ').trim();
}

/**
 * Why `title` can't be an issue title, or undefined if it can: 1–255 characters after
 * `normalizeTitle`, counted as the user sees them (code points). SPEC-011 §6.4 wording.
 */
export function issueTitleProblem(title: string): string | undefined {
  const normalized = normalizeTitle(title);
  if (normalized.length === 0) return 'Title is required.';
  if ([...normalized].length > ISSUE_TITLE_MAX_LENGTH) {
    return `Title must be ${ISSUE_TITLE_MAX_LENGTH} characters or fewer.`;
  }
  return undefined;
}

/** Whether `value` is an issue priority: `0` none, `1` urgent … `4` low (`PRIORITIES`). */
export function isPriority(value: unknown): value is Priority {
  return PRIORITIES.some((priority) => priority.value === value);
}

/** An issue's identifier, `ENG-42` (SPEC-011 §4.1): derived from the team key, never stored. */
export function issueIdentifier(teamKey: string, number: number): string {
  return `${teamKey}-${number}`;
}

/** Who wrote a history entry (SPEC-011 §4.4): the operation's actor kind. */
export const HISTORY_ACTOR_KINDS = ['user', 'api', 'mcp', 'system'] as const;
export type HistoryActorKind = (typeof HISTORY_ACTOR_KINDS)[number];

/** The kinds of history entry in M1 (SPEC-011 §4.4). Later milestones add theirs. */
export const ISSUE_HISTORY_KINDS = [
  'created',
  'updated',
  'deleted',
  'restored',
  'archived',
] as const;
export type IssueHistoryKind = (typeof ISSUE_HISTORY_KINDS)[number];

// ---------------------------------------------------------------------------------------------
// Status changes (SPEC-011 §4.6, state-machines §1)

/** The category timestamps the server maintains (INV-20). `T` is a `Date` or an ISO string. */
export interface CategoryTimestamps<T> {
  readonly startedAt: T | null;
  readonly completedAt: T | null;
  readonly canceledAt: T | null;
}

/** Why an issue can't be put in a status of `category`, or undefined if it can (Q2, §6.4). */
export function issueStatusProblem(category: StatusCategory): string | undefined {
  return category === 'triage' || category === 'duplicate'
    ? 'Triage and Duplicate are set by their own actions.'
    : undefined;
}

/**
 * The category timestamps after a status change from a status of `from` (null for a create) to
 * one of `to` (SPEC-011 §4.6). A change within one category keeps them all; a create applies its
 * initial category's effects to `current` (all null). `startedAt` records the first start, so it
 * is never cleared. Triage and Duplicate are refused before this is called (`issueStatusProblem`).
 */
export function statusSideEffects<T>(
  from: StatusCategory | null,
  to: StatusCategory,
  now: T,
  current: CategoryTimestamps<T>,
): CategoryTimestamps<T> {
  if (from === to) return current;
  const { startedAt } = current;
  switch (to) {
    case 'started':
      return { startedAt: startedAt ?? now, completedAt: null, canceledAt: null };
    case 'completed':
      return { startedAt, completedAt: now, canceledAt: null };
    case 'canceled':
      return { startedAt, completedAt: null, canceledAt: now };
    case 'backlog':
    case 'unstarted':
    case 'triage':
    case 'duplicate':
      return { startedAt, completedAt: null, canceledAt: null };
  }
}

const isSet = (value: unknown): boolean => value !== null && value !== undefined;

/** Why `issue`'s timestamps break INV-20 in `category` (SPEC-011 §4.6), or undefined. */
export function inv20Problem(
  issue: CategoryTimestamps<unknown>,
  category: StatusCategory,
): string | undefined {
  switch (category) {
    case 'completed':
      if (!isSet(issue.completedAt)) return 'A completed issue needs completedAt.';
      return isSet(issue.canceledAt) ? 'A completed issue has no canceledAt.' : undefined;
    case 'canceled':
      if (!isSet(issue.canceledAt)) return 'A canceled issue needs canceledAt.';
      return isSet(issue.completedAt) ? 'A canceled issue has no completedAt.' : undefined;
    case 'started':
    case 'backlog':
    case 'unstarted':
    case 'triage':
    case 'duplicate':
      if (category === 'started' && !isSet(issue.startedAt)) {
        return 'A started issue needs startedAt.';
      }
      return isSet(issue.completedAt) || isSet(issue.canceledAt)
        ? 'An open issue has no completedAt or canceledAt.'
        : undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Estimates (SPEC-011 §4.1, §6.4; SPEC-010 §4.3)

const SCALE_WORDS: Readonly<Record<EstimateScale, string>> = {
  off: 'off',
  linear: 'linear',
  exponential: 'exponential',
  fibonacci: 'fibonacci',
  tshirt: 't-shirt',
};

/**
 * Why `value` can't be **written** as the estimate of an issue of team `teamKey` under `config`,
 * or undefined (SPEC-011 §6.4). `null` clears it and is always allowed. A stored value that went
 * off-scale later stays until an edit changes it (E8), so callers check only a changed value.
 */
export function issueEstimateProblem(
  config: EstimateConfig,
  teamKey: string,
  value: number | null,
): string | undefined {
  if (value === null || isValidEstimate(config, value)) return undefined;
  if (config.scale === 'off') {
    return `${teamKey} doesn't use estimates. Turn them on in team settings, or leave the estimate empty.`;
  }
  const values = estimateValues(config).join(', ');
  return `${value} is not on ${teamKey}'s ${SCALE_WORDS[config.scale]} scale (${values}).`;
}

// ---------------------------------------------------------------------------------------------
// Labels on an issue (SPEC-011 §4.2, SPEC-010 §4.2)

/** At most 20 labels per issue (Q8). */
export const ISSUE_LABEL_LIMIT = 20;

/** What the issue label rules read about a label: its group rule, team and state. */
export interface IssueLabelFacts extends LabelInfo {
  readonly id: string;
  readonly name: string;
  readonly teamId: string | null;
  readonly isGroup: boolean;
  /** Any non-null value means archived (a `Date` on the server, an ISO string on the client). */
  readonly archivedAt: unknown;
}

export const ARCHIVED_LABEL_MESSAGE = 'That label is archived. Unarchive it in Settings → Labels.';

/**
 * Why `label` can't be **newly** added to an issue of team `teamId` (key `teamKey`), or undefined
 * (SPEC-011 §4.2, SPEC-010 E12, E13): a label of another team (INV-06), a group, an archived
 * label, or a label in an archived group. `labelsById` holds the label's group. A label the issue
 * already has is never checked again, so an archived one stays.
 */
export function issueLabelProblem(
  label: IssueLabelFacts,
  teamId: string,
  teamKey: string,
  labelsById: ReadonlyMap<string, IssueLabelFacts>,
): string | undefined {
  if (label.teamId !== null && label.teamId !== teamId) {
    return `That label belongs to another team. Use a label of ${teamKey} or a workspace label.`;
  }
  if (label.isGroup) return `${label.name} is a label group. Choose one of its labels.`;
  if (isSet(label.archivedAt)) return ARCHIVED_LABEL_MESSAGE;
  const group = label.parentId === null ? undefined : labelsById.get(label.parentId);
  if (group !== undefined && isSet(group.archivedAt)) return ARCHIVED_LABEL_MESSAGE;
  return undefined;
}

export const LABEL_LIMIT_MESSAGE = `An issue can have up to ${ISSUE_LABEL_LIMIT} labels. Remove one first.`;

export type LabelMerge =
  | { readonly ok: true; readonly labelIds: string[] }
  | { readonly ok: false; readonly problem: string };

/**
 * An issue's `labelIds` after `remove` and `add` (SPEC-011 §4.2): removing a label it doesn't
 * have and adding one it has are no-ops; then the exclusive-group rule (`applyLabelAdd`: an added
 * label of an exclusive group replaces the issue's others of that group, a multi-select group
 * keeps them); then the 20-label limit. Checking the added labels is `issueLabelProblem`'s, and a
 * label in both lists is refused before this runs.
 */
export function mergeLabels(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[],
  labelsById: ReadonlyMap<string, LabelInfo>,
): LabelMerge {
  const removing = new Set(remove);
  const labelIds = applyLabelAdd(
    labelsById,
    current.filter((id) => !removing.has(id)),
    add,
  );
  if (labelIds.length > ISSUE_LABEL_LIMIT) return { ok: false, problem: LABEL_LIMIT_MESSAGE };
  return { ok: true, labelIds };
}

// ---------------------------------------------------------------------------------------------
// Change sets (SPEC-011 E12, §4.4)

/** The fields an issue edit can change, in the order history lists them. */
export const ISSUE_EDIT_FIELDS = [
  'title',
  'statusId',
  'priority',
  'assigneeId',
  'labelIds',
  'estimate',
  'dueDate',
] as const;
export type IssueEditField = (typeof ISSUE_EDIT_FIELDS)[number];

export type IssueEditValues = { readonly [K in IssueEditField]: unknown };

export type IssueChangeSet = Partial<
  Record<IssueEditField, { readonly from: unknown; readonly to: unknown }>
>;

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * The fields an operation changed, `{ field: { from, to } }` (SPEC-011 §4.4). Empty means a no-op
 * (E12): no write, no history, no event. `labelIds` compares as the stored array.
 */
export function issueChangeSet(before: IssueEditValues, after: IssueEditValues): IssueChangeSet {
  const changes: IssueChangeSet = {};
  for (const field of ISSUE_EDIT_FIELDS) {
    if (!sameValue(before[field], after[field])) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------------------------
// URL slug (SPEC-011 §4.1, D6)

export const ISSUE_SLUG_MAX_LENGTH = 60;

/**
 * The cosmetic slug of an issue URL, `/issue/ENG-42/<slug>` (SPEC-011 §4.1): `foldToSlug` (the
 * branch name's folding, SPEC-012 D19), cut to 60 characters on a word boundary. A first word
 * longer than 60 is cut inside it. Empty when the title has no letters or digits.
 */
export function issueSlug(title: string): string {
  const slug = foldToSlug(title);
  if (slug.length <= ISSUE_SLUG_MAX_LENGTH) return slug;
  const cut = slug.slice(0, ISSUE_SLUG_MAX_LENGTH);
  if (slug[ISSUE_SLUG_MAX_LENGTH] === '-') return cut;
  const hyphen = cut.lastIndexOf('-');
  return hyphen > 0 ? cut.slice(0, hyphen) : cut;
}

/** The issue's path, `/issue/ENG-42/<slug>`, or `/issue/ENG-42` for an empty slug (§4.1). */
export function issuePath(identifier: string, title: string): string {
  const slug = issueSlug(title);
  return slug === '' ? `/issue/${identifier}` : `/issue/${identifier}/${slug}`;
}

/**
 * The issue's absolute URL on the workspace's address (`SURFACE_URL` on the server, the page's
 * origin on the client), as Linear's `url` (SPEC-011 §6.1, D11). A trailing slash on the base is
 * dropped, and a base with a path keeps it.
 */
export function issueUrl(base: string, identifier: string, title: string): string {
  return `${base.replace(/\/+$/, '')}${issuePath(identifier, title)}`;
}

// ---------------------------------------------------------------------------------------------
// Filters (SPEC-011 §6.1, SPEC-003 §7.4)

/**
 * The filterable fields of `issue.list`, `count` and `groupBy`, shared by the client evaluator
 * and the server's SQL compiler. `status`, `labels`, `team`, `assignee` and `creator` take ids, or
 * names that the server resolves (statuses and labels within the input's `team`).
 */
export const ISSUE_FILTER_FIELDS = defineFilterFields({
  team: { type: 'ref' },
  number: { type: 'number' },
  title: { type: 'text' },
  status: { type: 'ref' },
  'status.category': { type: 'enum', values: STATUS_CATEGORIES },
  priority: { type: 'number' },
  assignee: { type: 'ref' },
  creator: { type: 'ref' },
  labels: { type: 'refs' },
  estimate: { type: 'number' },
  dueDate: { type: 'day' },
  createdAt: { type: 'instant' },
  updatedAt: { type: 'instant' },
  startedAt: { type: 'instant' },
  completedAt: { type: 'instant' },
  canceledAt: { type: 'instant' },
  archivedAt: { type: 'instant' },
});
