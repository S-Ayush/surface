/**
 * Issue operations (SPEC-011 §6.1; PLAN-011 S4): create, update, get, list, count, groupBy.
 * Anyone who can see a team can create and edit its issues (§5.6, Q3), so the permission is
 * `p.any()`: visibility is the executor's check on every reference, and a private team's issue is
 * `NOT_FOUND` before any permission check. Statuses and labels of `issue.update` resolve within
 * the issue's own team (`scopedTo(…, 'issue')`), never a team named elsewhere.
 *
 * `IssueOutput` has no `description` or `version` until S6, and no `attachments` or `reactions`
 * until PLAN-014 and PLAN-013; each adds its fields, additively. `issue.create` takes no
 * description until S6.
 *
 * Optimistic updates call the same domain rules as the handlers (`@surface/domain` `issue.ts`),
 * so the client predicts what the server commits, apart from the number and `sortOrder` (§6.2).
 */
import {
  IssueRef,
  issueEstimateProblem,
  issueLabelProblem,
  issueStatusProblem,
  issueTitleProblem,
  ISSUE_LABEL_LIMIT,
  isStatusCategory,
  jitterFromId,
  keyBefore,
  LabelRef,
  lifecycleOf,
  mergeLabels,
  normalizeTitle,
  parseLabelRef,
  scopedTo,
  STATUS_CATEGORIES,
  StatusRef,
  statusSideEffects,
  TeamRef,
  UserRef,
  type CategoryTimestamps,
  type EstimateConfig,
  type EstimateScale,
  type IssueLabelFacts,
  type StatusCategory,
} from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import { connectionOf, countInput, CountOutput, listInput } from '../list.js';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import { Timestamp } from './shared.js';

// ---------------------------------------------------------------------------------------------
// Shapes

/** 1–255 characters after trimming; line breaks become spaces (§4.1, Q5). */
const IssueTitle = z
  .string()
  .max(10_000, 'Title must be 255 characters or fewer.')
  .superRefine((title, ctx) => {
    const problem = issueTitleProblem(title);
    if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
  });

const Priority = z
  .int('Priority must be a whole number from 0 (none) to 4 (low)')
  .min(0, 'Priority must be from 0 (none) to 4 (low)')
  .max(4, 'Priority must be from 0 (none) to 4 (low)');

const Estimate = z.int('Estimate must be a whole number, like 3');

const DueDate = z.iso.date('Due date must be a calendar date, like 2026-11-30');

const NewId = z
  .uuid({
    version: 'v7',
    error: 'Use a UUIDv7 for id, or leave it out and the server makes one',
  })
  .optional();

const Named = z.object({ id: z.uuid(), name: z.string() });

/** One issue in a list (§6.1). `url` is absolute, on your Surface address: `https://surface.example.com/issue/ENG-42/<slug>` (D11). */
export const IssueSummarySchema = z.object({
  id: z.uuid(),
  identifier: z.string(),
  teamKey: z.string(),
  title: z.string(),
  status: z.object({ id: z.uuid(), name: z.string(), category: z.enum(STATUS_CATEGORIES) }),
  priority: z.int().min(0).max(4),
  assignee: Named.nullable(),
  labels: z.array(z.object({ id: z.uuid(), name: z.string(), color: z.string() })),
  estimate: z.int().nullable(),
  dueDate: z.iso.date().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  completedAt: Timestamp.nullable(),
  archivedAt: Timestamp.nullable(),
  deletedAt: Timestamp.nullable(),
  deletedBy: Named.nullable(),
  url: z.string(),
});

/** One issue with every M1 field (§6.1). S6 adds `description` and `version`. */
export const IssueOutputSchema = IssueSummarySchema.extend({
  creator: Named,
  startedAt: Timestamp.nullable(),
  canceledAt: Timestamp.nullable(),
});

export const ISSUE_GROUPINGS = ['status', 'assignee', 'priority', 'label'] as const;

/** At most this many groups (§6.1); the largest come first. */
export const ISSUE_GROUP_LIMIT = 500;

// ---------------------------------------------------------------------------------------------
// Optimistic helpers: the store's rows as the shared rules read them

function text(row: StoreRow | undefined, field: string): string | undefined {
  const value = row?.[field];
  return typeof value === 'string' ? value : undefined;
}

function nullableText(row: StoreRow, field: string): string | null {
  return text(row, field) ?? null;
}

function idsOf(row: StoreRow, field: string): string[] {
  const value = row[field];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function labelFacts(row: StoreRow): IssueLabelFacts | undefined {
  const id = text(row, 'id');
  const name = text(row, 'name');
  if (id === undefined || name === undefined) return undefined;
  return {
    id,
    name,
    teamId: nullableText(row, 'teamId'),
    parentId: nullableText(row, 'parentId'),
    isGroup: row['isGroup'] === true,
    exclusive: row['exclusive'] !== false,
    archivedAt: row['archivedAt'] ?? null,
  };
}

/** The labels an issue of `teamId` may carry or name: the team's and the workspace's. */
function usableLabels(store: OptimisticStore, teamId: string): Map<string, IssueLabelFacts> {
  const rows = [...store.find('Label', { teamId }), ...store.find('Label', { teamId: null })];
  const map = new Map<string, IssueLabelFacts>();
  for (const row of rows) {
    const facts = labelFacts(row);
    if (facts) map.set(facts.id, facts);
  }
  return map;
}

/**
 * The label `ref` names, like the server's `LabelRef` lookup scoped to the issue's team: an id
 * (any label the store holds), or a name or `Group/Label` among the team's labels first and then
 * the workspace's. Undefined when none or several match: the server answers those.
 */
function findLabel(
  store: OptimisticStore,
  usable: ReadonlyMap<string, IssueLabelFacts>,
  ref: string,
): IssueLabelFacts | undefined {
  const parsed = parseLabelRef(ref);
  if (parsed?.by === 'id') {
    const row = store.get('Label', parsed.id);
    return row && labelFacts(row);
  }
  if (parsed?.by !== 'name' && parsed?.by !== 'groupLabel') return undefined;
  const wanted = parsed.name.toLowerCase();
  const all = [...usable.values()];
  const matching = all.filter((l) => {
    if (l.name.toLowerCase() !== wanted) return false;
    if (parsed.by !== 'groupLabel') return true;
    const group = l.parentId === null ? undefined : usable.get(l.parentId);
    return group?.name.toLowerCase() === parsed.group.toLowerCase();
  });
  const inTeam = matching.filter((l) => l.teamId !== null);
  const pool = inTeam.length > 0 ? inTeam : matching;
  if (pool.length <= 1) return pool[0];
  const exact = pool.filter((l) => l.name === parsed.name);
  return exact.length === 1 ? exact[0] : undefined;
}

interface StoreStatus {
  readonly id: string;
  readonly category: StatusCategory;
}

/** A status of the team by id or name (any case; an exact-case match settles several). */
function findStatus(store: OptimisticStore, teamId: string, ref: string): StoreStatus | undefined {
  const rows = store.find('WorkflowStatus', { teamId });
  const lower = ref.trim().toLowerCase();
  const byId = rows.find((r) => text(r, 'id') === lower);
  let row = byId;
  if (row === undefined) {
    const named = rows.filter((r) => text(r, 'name')?.toLowerCase() === lower);
    const exact = named.filter((r) => text(r, 'name') === ref.trim());
    row = named.length === 1 ? named[0] : exact.length === 1 ? exact[0] : undefined;
  }
  const id = text(row, 'id');
  const category = text(row, 'category');
  return id !== undefined && isStatusCategory(category) ? { id, category } : undefined;
}

function categoryOf(store: OptimisticStore, statusId: string): StatusCategory | undefined {
  const category = text(store.get('WorkflowStatus', statusId), 'category');
  return isStatusCategory(category) ? category : undefined;
}

const SCALES: readonly EstimateScale[] = ['off', 'linear', 'exponential', 'fibonacci', 'tshirt'];

function estimateConfigOf(team: StoreRow): EstimateConfig {
  const scale = SCALES.find((s) => s === team['estimateScale']) ?? 'off';
  return {
    scale,
    extended: team['estimateExtended'] === true,
    allowZero: team['estimateAllowZero'] === true,
  };
}

function timestamps(row: StoreRow): CategoryTimestamps<string> {
  return {
    startedAt: nullableText(row, 'startedAt'),
    completedAt: nullableText(row, 'completedAt'),
    canceledAt: nullableText(row, 'canceledAt'),
  };
}

/** The lowest `sortOrder` among the team's issues the store holds, in byte order. */
function lowestSortOrder(store: OptimisticStore, teamId: string): string | null {
  let lowest: string | null = null;
  for (const row of store.find('Issue', { teamId })) {
    const key = text(row, 'sortOrder');
    if (key !== undefined && (lowest === null || key < lowest)) lowest = key;
  }
  return lowest;
}

/** The ids `refs` name among `usable`, or undefined when one can't be found. */
function labelIdsOf(
  store: OptimisticStore,
  usable: ReadonlyMap<string, IssueLabelFacts>,
  refs: readonly string[],
): IssueLabelFacts[] | undefined {
  const out: IssueLabelFacts[] = [];
  for (const ref of refs) {
    const label = findLabel(store, usable, ref);
    if (label === undefined) return undefined;
    out.push(label);
  }
  return out;
}

/** Adds every label's group to `labels`, so the rules can read groups outside the scope too. */
function withGroups(
  store: OptimisticStore,
  usable: Map<string, IssueLabelFacts>,
  labels: readonly IssueLabelFacts[],
): Map<string, IssueLabelFacts> {
  for (const label of labels) {
    usable.set(label.id, label);
    if (label.parentId !== null && !usable.has(label.parentId)) {
      const group = store.get('Label', label.parentId);
      const facts = group && labelFacts(group);
      if (facts) usable.set(facts.id, facts);
    }
  }
  return usable;
}

// ---------------------------------------------------------------------------------------------
// Mutations

export const issueCreate = defineOperation({
  name: 'issue.create',
  kind: 'mutation',
  domain: 'issue',
  summary: 'Create an issue',
  description:
    "Creates an issue in a team and returns it with its identifier, like ENG-42. status is a status name of the team (default: the team's default status), never Triage or Duplicate. labels are names of the team's or workspace labels (Group/Label for one in a group), at most 20. assignee takes an email, a name or me.",
  keywords: ['create issue', 'new issue', 'file a bug', 'add a task', 'report a problem'],
  input: z.object({
    /** Client-generated UUIDv7 (SPEC-003 §8); generated by the server when absent. */
    id: NewId,
    team: TeamRef,
    title: IssueTitle,
    status: StatusRef.optional(),
    priority: Priority.optional(),
    assignee: UserRef.optional(),
    labels: z
      .array(LabelRef)
      .max(ISSUE_LABEL_LIMIT, `An issue can have up to ${ISSUE_LABEL_LIMIT} labels.`)
      .optional(),
    estimate: Estimate.nullable().optional(),
    dueDate: DueDate.nullable().optional(),
  }),
  output: IssueOutputSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [
    { team: 'ENG', title: 'Fix the login redirect loop' },
    { team: 'ENG', title: 'Write the release notes', status: 'Todo', priority: 3, assignee: 'me' },
  ],
  ui: { title: 'Create issue…', icon: 'plus', contexts: ['team', 'global'], shortcut: null },
  optimistic: (store, input) => {
    // Without an id the server decides; nothing to predict.
    if (input.id === undefined) return;
    const team = store.get('Team', input.team);
    const teamId = text(team, 'id');
    const teamKey = text(team, 'key');
    const creatorId = text(store.get('User', 'me'), 'id');
    if (!team || teamId === undefined || teamKey === undefined || creatorId === undefined) return;

    const status =
      input.status === undefined
        ? (() => {
            const id = text(team, 'defaultStatusId');
            const category = id === undefined ? undefined : categoryOf(store, id);
            return id !== undefined && category !== undefined ? { id, category } : undefined;
          })()
        : findStatus(store, teamId, input.status);
    if (status === undefined || issueStatusProblem(status.category) !== undefined) return;

    const usable = usableLabels(store, teamId);
    const added = labelIdsOf(store, usable, input.labels ?? []);
    if (added === undefined) return;
    const facts = withGroups(store, usable, added);
    if (added.some((l) => issueLabelProblem(l, teamId, teamKey, facts) !== undefined)) return;
    const merged = mergeLabels(
      [],
      added.map((l) => l.id),
      [],
      facts,
    );
    if (!merged.ok) return;

    const estimate = input.estimate ?? null;
    if (issueEstimateProblem(estimateConfigOf(team), teamKey, estimate) !== undefined) return;

    let assigneeId: string | null = null;
    if (input.assignee !== undefined) {
      const assignee = text(store.get('User', input.assignee), 'id');
      if (assignee === undefined) return;
      assigneeId = assignee;
    }

    const at = store.now.toISOString();
    const stamps = statusSideEffects<string>(null, status.category, at, {
      startedAt: null,
      completedAt: null,
      canceledAt: null,
    });
    const groups = team['groups'];
    store.insert('Issue', {
      id: input.id,
      teamId,
      number: null,
      title: normalizeTitle(input.title),
      statusId: status.id,
      priority: input.priority ?? 0,
      assigneeId,
      labelIds: merged.labelIds,
      estimate,
      dueDate: input.dueDate ?? null,
      // A prediction like the number: the server's key is computed under the counter lock (§4.5).
      sortOrder: keyBefore(lowestSortOrder(store, teamId), jitterFromId(input.id)),
      creatorId,
      ...stamps,
      archivedAt: null,
      deletedAt: null,
      deletedById: null,
      groups: Array.isArray(groups) ? groups : [],
      createdAt: at,
      updatedAt: at,
    });
  },
});

export const issueUpdate = defineOperation({
  name: 'issue.update',
  kind: 'mutation',
  domain: 'issue',
  summary: 'Change an issue’s title, status, priority, assignee, labels or dates',
  description:
    'Changes any of title, status, priority, assignee, estimate and dueDate (null clears assignee, estimate and dueDate), and adds or removes labels. Status and label names are those of the issue’s team. Adding a label of a single-choice group replaces the issue’s other label of it. Archived and deleted issues can’t be edited. A change to nothing writes nothing.',
  keywords: [
    'update issue',
    'change status',
    'assign issue',
    'set priority',
    'add label',
    'move to done',
  ],
  input: z.object({
    issue: IssueRef,
    title: IssueTitle.optional(),
    status: scopedTo(StatusRef, 'issue').optional(),
    priority: Priority.optional(),
    assignee: UserRef.nullable().optional(),
    estimate: Estimate.nullable().optional(),
    dueDate: DueDate.nullable().optional(),
    addLabels: z
      .array(scopedTo(LabelRef, 'issue'))
      .max(ISSUE_LABEL_LIMIT, `An issue can have up to ${ISSUE_LABEL_LIMIT} labels.`)
      .optional(),
    removeLabels: z
      .array(scopedTo(LabelRef, 'issue'))
      .max(ISSUE_LABEL_LIMIT, `An issue can have up to ${ISSUE_LABEL_LIMIT} labels.`)
      .optional(),
  }),
  output: IssueOutputSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [
    { issue: 'ENG-1', status: 'In Progress', assignee: 'me' },
    { issue: 'ENG-1', priority: 2, dueDate: '2026-12-01' },
  ],
  optimistic: (store, input) => {
    const issue = store.get('Issue', input.issue);
    const id = text(issue, 'id');
    const teamId = text(issue, 'teamId');
    if (!issue || id === undefined || teamId === undefined) return;
    // The server refuses edits of archived and deleted issues (§6.1); the client predicts nothing.
    if (
      lifecycleOf({ archivedAt: issue['archivedAt'], deletedAt: issue['deletedAt'] }) !== 'live'
    ) {
      return;
    }
    const team = store.get('Team', teamId);
    const teamKey = text(team, 'key');
    if (!team || teamKey === undefined) return;

    const currentStatusId = text(issue, 'statusId');
    const fromCategory =
      currentStatusId === undefined ? undefined : categoryOf(store, currentStatusId);
    let status: StoreStatus | undefined;
    if (input.status !== undefined) {
      status = findStatus(store, teamId, input.status);
      if (status === undefined || issueStatusProblem(status.category) !== undefined) return;
    }

    const usable = usableLabels(store, teamId);
    const added = labelIdsOf(store, usable, input.addLabels ?? []);
    const removed = (input.removeLabels ?? []).map((ref) => findLabel(store, usable, ref));
    if (added === undefined || removed.some((l) => l === undefined)) return;
    const removedIds = removed.flatMap((l) => (l ? [l.id] : []));
    if (added.some((l) => removedIds.includes(l.id))) return;
    const current = idsOf(issue, 'labelIds');
    const facts = withGroups(store, usable, added);
    const fresh = added.filter((l) => !current.includes(l.id));
    if (fresh.some((l) => issueLabelProblem(l, teamId, teamKey, facts) !== undefined)) return;
    const merged = mergeLabels(
      current,
      added.map((l) => l.id),
      removedIds,
      facts,
    );
    if (!merged.ok) return;

    const changes: Record<string, unknown> = {};
    const set = (field: string, value: unknown) => {
      const old = issue[field];
      const same =
        Array.isArray(old) && Array.isArray(value)
          ? old.length === value.length && old.every((v, i) => v === value[i])
          : old === value;
      if (!same) changes[field] = value;
    };
    if (input.title !== undefined) set('title', normalizeTitle(input.title));
    if (status !== undefined) set('statusId', status.id);
    if (input.priority !== undefined) set('priority', input.priority);
    if (input.assignee !== undefined) {
      const assigneeId =
        input.assignee === null ? null : text(store.get('User', input.assignee), 'id');
      if (assigneeId === undefined) return;
      set('assigneeId', assigneeId);
    }
    if (input.estimate !== undefined && input.estimate !== issue['estimate']) {
      if (issueEstimateProblem(estimateConfigOf(team), teamKey, input.estimate) !== undefined) {
        return;
      }
      set('estimate', input.estimate);
    }
    if (input.dueDate !== undefined) set('dueDate', input.dueDate);
    set('labelIds', merged.labelIds);
    // A no-op writes nothing and moves no updatedAt (E12).
    if (Object.keys(changes).length === 0) return;

    const at = store.now.toISOString();
    if (status !== undefined && fromCategory !== undefined && 'statusId' in changes) {
      const before = timestamps(issue);
      const after = statusSideEffects(fromCategory, status.category, at, before);
      for (const field of ['startedAt', 'completedAt', 'canceledAt'] as const) {
        if (after[field] !== before[field]) changes[field] = after[field];
      }
    }
    store.patch('Issue', id, { ...changes, updatedAt: at });
  },
});

// ---------------------------------------------------------------------------------------------
// Queries

export const issueGet = defineOperation({
  name: 'issue.get',
  kind: 'query',
  domain: 'issue',
  summary: 'Get an issue',
  description:
    'Returns one issue by identifier (ENG-42) or id, with its status, assignee, labels, estimate, due date, dates and creator. Archived and deleted issues are returned too, with archivedAt or deletedAt set. Use fields to pick parts, like status.name.',
  keywords: ['get issue', 'show issue', 'issue details', 'look up ENG-42'],
  input: z.object({ issue: IssueRef }),
  output: IssueOutputSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ issue: 'ENG-1' }],
});

const issueListFilters =
  'Filters: team, number, title, status, status.category, priority, assignee (me works), creator, labels, estimate, dueDate, createdAt, updatedAt, startedAt, completedAt, canceledAt, archivedAt.';

export const issueList = defineOperation({
  name: 'issue.list',
  kind: 'query',
  domain: 'issue',
  summary: 'List issues',
  description: `Lists visible issues in manual order unless orderBy says otherwise. Deleted issues never appear; archived ones only with includeArchived. With team, only its issues, and status and label names resolve in it. ${issueListFilters}`,
  keywords: ['list issues', 'find issues', 'my issues', 'open bugs', 'search issues'],
  input: z.object({ ...listInput, team: TeamRef.optional(), withTotal: z.boolean().optional() }),
  output: connectionOf(IssueSummarySchema),
  permission: (p) => p.any(),
  destructive: false,
  examples: [
    { team: 'ENG' },
    {
      team: 'ENG',
      filter: { field: 'assignee', op: 'eq', value: 'me' },
      orderBy: { field: 'priority', direction: 'asc' },
    },
  ],
});

export const issueCount = defineOperation({
  name: 'issue.count',
  kind: 'query',
  domain: 'issue',
  summary: 'Count issues',
  description: `Counts the issues issue.list would return for the same filter, without listing them. Deleted issues are never counted; archived ones only with includeArchived. ${issueListFilters}`,
  keywords: ['count issues', 'how many issues', 'number of open bugs'],
  input: z.object({ ...countInput, team: TeamRef.optional() }),
  output: CountOutput,
  permission: (p) => p.any(),
  destructive: false,
  examples: [
    { team: 'ENG' },
    { filter: { field: 'status.category', op: 'in', value: ['unstarted', 'started'] } },
  ],
});

export const issueGroupBy = defineOperation({
  name: 'issue.groupBy',
  kind: 'query',
  domain: 'issue',
  summary: 'Count issues per status, assignee, priority or label',
  description:
    'Counts the issues issue.list would return, grouped by status, assignee, priority or label, largest group first, at most 500 groups. key is the id (the number for priority), or null for No assignee and No label. By label, an issue counts in each of its labels.',
  keywords: ['group issues', 'issues per status', 'workload by assignee', 'breakdown by label'],
  input: z.object({
    ...countInput,
    team: TeamRef.optional(),
    by: z.enum(ISSUE_GROUPINGS, 'Group by status, assignee, priority or label'),
  }),
  output: z.object({
    groups: z.array(z.object({ key: z.string().nullable(), name: z.string(), count: z.int() })),
  }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [
    { team: 'ENG', by: 'status' },
    { by: 'assignee', filter: { field: 'status.category', op: 'eq', value: 'started' } },
  ],
});
