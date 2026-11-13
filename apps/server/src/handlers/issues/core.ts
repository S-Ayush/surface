/**
 * The rules of `issue.create` and `issue.update` (SPEC-011 §4.1–§4.8, §6.1), written against
 * `IssueAccess` (reads and locks) and the repo (writes), so the unit tests run them in memory
 * while the handlers run them on Postgres (`access.ts`). The pure checks live in the domain
 * package (`issue.ts`), which the client's `optimistic` calls too.
 *
 * Lock order (SPEC-011 §4.8): create takes the team row `FOR SHARE`, then `FOR KEY SHARE` on the
 * status and the labels it writes (status first, labels in ascending id), then the team's counter
 * (`newIssuePosition`), then inserts. Update takes `FOR KEY SHARE` on the status and labels it
 * sets, then the issue row (`lockIssueForWrite`, mode `edit`). References were resolved before
 * these locks, so every status and label is **re-read** under its lock: one gone meanwhile is
 * `CONFLICT` (E19, E22), and INV-06, INV-07 and INV-20 are checked on the re-read rows.
 */
import {
  inv20Problem,
  issueChangeSet,
  issueEstimateProblem,
  issueLabelProblem,
  issueLockModeOf,
  issueStatusProblem,
  mergeLabels,
  normalizeTitle,
  statusSideEffects,
  type EstimateScale,
  type IssueChangeSet,
  type IssueLabelFacts,
  type IssueLockMode,
  type StatusCategory,
} from '@surface/domain';
import type { DomainEvent } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { refNotFound } from '../../executor/refs/sources.js';
import type { LockedIssue } from '../../issues/lifecycle.js';
import type { ModelPatch, ModelRow } from '../../sync/models.js';
import type { Repo } from '../../sync/repo.js';

export type IssueRow = ModelRow<'Issue'>;
export type LabelRow = ModelRow<'Label'>;

/** What the issue rules read about a team. */
export interface IssueTeam {
  readonly id: string;
  readonly key: string;
  readonly defaultStatusId: string;
  readonly estimateScale: EstimateScale;
  readonly estimateExtended: boolean;
  readonly estimateAllowZero: boolean;
}

export interface StatusFacts {
  readonly id: string;
  readonly teamId: string;
  readonly category: StatusCategory;
}

/** Reads and locks, in the order of §4.8. Every method runs in the operation's transaction. */
export interface IssueAccess {
  /** The team row `FOR SHARE` (create); undefined when it is gone. */
  shareTeam(teamId: string): Promise<IssueTeam | undefined>;
  /** The team row without a lock (update, before the issue lock); undefined when it is gone. */
  readTeam(teamId: string): Promise<IssueTeam | undefined>;
  /** The status `FOR KEY SHARE`; undefined when it is gone. */
  shareStatus(statusId: string): Promise<StatusFacts | undefined>;
  /** The labels `FOR KEY SHARE`, locked in ascending id; labels that are gone are left out. */
  shareLabels(labelIds: readonly string[]): Promise<LabelRow[]>;
  /** Labels without a lock (the groups of labels being added). */
  readLabels(labelIds: readonly string[]): Promise<LabelRow[]>;
  /** A status's category without a lock (the issue's current status, for §4.6). */
  statusCategory(statusId: string): Promise<StatusCategory | undefined>;
  /** The team's next number and the new issue's sort key, under the counter lock (§4.5). */
  position(teamId: string): Promise<{ readonly number: number; readonly sortOrder: string }>;
  /**
   * `lockIssueForWrite` in `mode`, the mode the lifecycle rule table gives the operation
   * (SPEC-015 §4.3): in `edit`, archived and deleted issues are `CONFLICT` (§6.1).
   */
  lockIssue(issueId: string, mode: IssueLockMode): Promise<LockedIssue>;
}

/** What the rules need from the operation besides reads and writes. */
export interface IssueWriteContext {
  readonly access: IssueAccess;
  readonly repo: Repo;
  readonly emit: (event: DomainEvent) => void;
  readonly now: Date;
}

export const STATUS_GONE = 'That status was deleted. Choose another status.';
export const LABEL_GONE = 'That label was deleted. Choose another label.';

function invalid(path: readonly (string | number)[], message: string): SurfaceError {
  return new SurfaceError('INVALID_INPUT', message, { issues: [{ path, message }] });
}

function conflict(path: readonly (string | number)[], message: string): SurfaceError {
  return new SurfaceError('CONFLICT', message, { issues: [{ path, message }] });
}

function labelFacts(row: LabelRow): IssueLabelFacts {
  return {
    id: row.id,
    name: row.name,
    teamId: row.teamId,
    parentId: row.parentId,
    isGroup: row.isGroup,
    exclusive: row.exclusive,
    archivedAt: row.archivedAt,
  };
}

/** Unique ids in ascending order: the order key locks are taken in (§4.8). */
function ascending(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** Re-reads the status under its key lock; one deleted since resolution is `CONFLICT` (E19). */
async function lockedStatus(access: IssueAccess, statusId: string): Promise<StatusFacts> {
  const status = await access.shareStatus(statusId);
  if (status === undefined) throw conflict(['status'], STATUS_GONE);
  return status;
}

/**
 * Checks a locked status for an issue of `team` (INV-06, §4.6). A status resolves within the
 * issue's team (§6.4), so one of another team reads exactly like an unknown status.
 */
function checkStatus(status: StatusFacts, team: IssueTeam, statusRef: string | undefined): void {
  if (status.teamId !== team.id) {
    throw refNotFound('StatusRef', statusRef ?? status.id, ['status'], {
      id: team.id,
      key: team.key,
    });
  }
  const problem = issueStatusProblem(status.category);
  if (problem !== undefined) throw invalid(['status'], problem);
}

/**
 * Re-reads the labels being added under their key locks (ascending id), and reads their groups.
 * A label gone meanwhile is `CONFLICT` (E22). Returns every label the rules need, by id.
 */
async function lockedLabels(
  access: IssueAccess,
  labelIds: readonly string[],
  field: string,
): Promise<Map<string, IssueLabelFacts>> {
  const facts = new Map<string, IssueLabelFacts>();
  if (labelIds.length === 0) return facts;
  for (const row of await access.shareLabels(ascending(labelIds)))
    facts.set(row.id, labelFacts(row));
  const gone = labelIds.findIndex((id) => !facts.has(id));
  if (gone >= 0) throw conflict([field, gone], LABEL_GONE);
  const groupIds = [...facts.values()].flatMap((l) =>
    l.parentId !== null && !facts.has(l.parentId) ? [l.parentId] : [],
  );
  if (groupIds.length > 0) {
    for (const row of await access.readLabels(ascending(groupIds))) {
      facts.set(row.id, labelFacts(row));
    }
  }
  return facts;
}

/** Refuses a newly added label that breaks §4.2 (INV-06, a group, archived: SPEC-010 E12, E13). */
function checkNewLabels(
  labelIds: readonly string[],
  isNew: (id: string) => boolean,
  facts: ReadonlyMap<string, IssueLabelFacts>,
  team: { readonly id: string; readonly key: string },
  field: string,
): void {
  labelIds.forEach((id, index) => {
    const label = facts.get(id);
    if (label === undefined || !isNew(id)) return;
    const problem = issueLabelProblem(label, team.id, team.key, facts);
    if (problem !== undefined) throw invalid([field, index], problem);
  });
}

function checkEstimate(team: IssueTeam, estimate: number | null): void {
  const config = {
    scale: team.estimateScale,
    extended: team.estimateExtended,
    allowZero: team.estimateAllowZero,
  };
  const problem = issueEstimateProblem(config, team.key, estimate);
  if (problem !== undefined) throw invalid(['estimate'], problem);
}

function checkInv20(
  stamps: { startedAt: Date | null; completedAt: Date | null; canceledAt: Date | null },
  category: StatusCategory,
): void {
  // A bug, never bad input: the side effects always satisfy INV-20 (domain property test).
  const problem = inv20Problem(stamps, category);
  if (problem !== undefined) throw new Error(`INV-20 broken: ${problem}`);
}

// ---------------------------------------------------------------------------------------------

export interface CreateIssueInput {
  readonly id: string;
  /** The team the executor resolved, and the input's spelling of it for messages. */
  readonly team: { readonly id: string };
  readonly teamRef: string;
  readonly title: string;
  /** Resolved within the team; the team's default status when absent (AC-1). */
  readonly statusId?: string | undefined;
  /** The input's spelling of the status, for messages. */
  readonly statusRef?: string | undefined;
  readonly priority?: number | undefined;
  readonly assigneeId: string | null;
  /** Resolved label ids, in input order. */
  readonly labelIds: readonly string[];
  readonly estimate: number | null;
  readonly dueDate: string | null;
  /** The actor (for `api`/`mcp`, the key's owner). Never null (§4.1). */
  readonly creatorId: string;
}

/** `issue.create` (AC-1, AC-2, AC-4, §4.6): returns the inserted row. */
export async function createIssue(
  ctx: IssueWriteContext,
  input: CreateIssueInput,
): Promise<IssueRow> {
  const { access, repo, now } = ctx;
  const team = await access.shareTeam(input.team.id);
  // Resolved and visible at step 7; gone only if deleted since, so it reads like an unknown team.
  if (team === undefined) throw refNotFound('TeamRef', input.teamRef, ['team']);

  const status = await lockedStatus(access, input.statusId ?? team.defaultStatusId);
  checkStatus(status, team, input.statusRef);
  const facts = await lockedLabels(access, input.labelIds, 'labels');
  checkNewLabels(input.labelIds, () => true, facts, team, 'labels');
  const merged = mergeLabels([], input.labelIds, [], facts);
  if (!merged.ok) throw invalid(['labels'], merged.problem);
  checkEstimate(team, input.estimate);

  // The counter lock comes after the key locks (§4.8), and the sort key is read under it (§4.5).
  const { number, sortOrder } = await access.position(team.id);
  const stamps = statusSideEffects<Date>(null, status.category, now, {
    startedAt: null,
    completedAt: null,
    canceledAt: null,
  });
  checkInv20(stamps, status.category);
  const row = await repo.insert('Issue', {
    id: input.id,
    teamId: team.id,
    number,
    title: normalizeTitle(input.title),
    statusId: status.id,
    priority: input.priority ?? 0,
    assigneeId: input.assigneeId,
    labelIds: merged.labelIds,
    estimate: input.estimate,
    dueDate: input.dueDate,
    sortOrder,
    creatorId: input.creatorId,
    ...stamps,
  });
  ctx.emit({
    type: 'issue.created',
    subject: { type: 'issue', id: row.id },
    data: { teamId: row.teamId, number: row.number, assigneeId: row.assigneeId },
  });
  return row;
}

export interface UpdateIssueInput {
  readonly issueId: string;
  /** The issue's team as the executor resolved it; the team never changes in M1. */
  readonly teamId: string;
  readonly title?: string | undefined;
  readonly statusId?: string | undefined;
  /** The input's spelling of the status, for messages. */
  readonly statusRef?: string | undefined;
  readonly priority?: number | undefined;
  /** `null` clears; `undefined` leaves it. */
  readonly assigneeId?: string | null | undefined;
  readonly estimate?: number | null | undefined;
  readonly dueDate?: string | null | undefined;
  readonly addLabelIds: readonly string[];
  readonly removeLabelIds: readonly string[];
}

/**
 * `issue.update` (AC-1, AC-3, AC-4, AC-23, E8, E12, E19, E22): writes only the fields that change,
 * with the §4.6 side effects; a no-op writes nothing and emits nothing. Returns the issue as
 * stored afterwards, and what changed.
 */
export async function updateIssue(
  ctx: IssueWriteContext,
  input: UpdateIssueInput,
): Promise<{ readonly row: IssueRow; readonly changes: IssueChangeSet }> {
  const { access, repo, now } = ctx;
  // Read before any lock: the team's key and estimate settings. A plain read takes no lock, so
  // nothing about the team is read under the issue lock (§4.8).
  const team = await access.readTeam(input.teamId);
  if (team === undefined) throw refNotFound('IssueRef', input.issueId, ['issue']);

  // Key locks on what the edit sets, before the issue lock (§4.8, AC-20).
  const status =
    input.statusId === undefined ? undefined : await lockedStatus(access, input.statusId);
  const facts = await lockedLabels(access, input.addLabelIds, 'addLabels');
  // The issue's own state is checked first (AC-23): an archived or deleted issue is CONFLICT
  // whatever else the edit gets wrong, so the input checks run after the issue lock.
  const issue = await access.lockIssue(input.issueId, issueLockModeOf('issue.update'));
  if (issue.teamId !== team.id) {
    throw new SurfaceError('CONFLICT', 'This issue moved to another team. Reload and try again.');
  }
  if (status !== undefined) checkStatus(status, team, input.statusRef);
  const both = input.addLabelIds.findIndex((id) => input.removeLabelIds.includes(id));
  if (both >= 0) {
    throw invalid(['addLabels', both], "A label can't be in both addLabels and removeLabels.");
  }

  checkNewLabels(input.addLabelIds, (id) => !issue.labelIds.includes(id), facts, team, 'addLabels');
  // An add replaces a current label of the same exclusive group (D20), so the rules need the
  // current labels' groups too. A plain read: no key lock is taken after the issue lock (§4.8).
  const unread =
    input.addLabelIds.length === 0 ? [] : issue.labelIds.filter((id) => !facts.has(id));
  if (unread.length > 0) {
    for (const row of await access.readLabels(ascending(unread)))
      facts.set(row.id, labelFacts(row));
  }
  const merged = mergeLabels(issue.labelIds, input.addLabelIds, input.removeLabelIds, facts);
  if (!merged.ok) throw invalid(['addLabels'], merged.problem);

  const after = {
    title: input.title === undefined ? issue.title : normalizeTitle(input.title),
    statusId: status?.id ?? issue.statusId,
    priority: input.priority ?? issue.priority,
    assigneeId: input.assigneeId === undefined ? issue.assigneeId : input.assigneeId,
    labelIds: merged.labelIds,
    estimate: input.estimate === undefined ? issue.estimate : input.estimate,
    dueDate: input.dueDate === undefined ? issue.dueDate : input.dueDate,
  };
  const changes = issueChangeSet(issue, after);
  // E12: nothing changes, so nothing is written, logged or emitted.
  if (Object.keys(changes).length === 0) return { row: issue, changes };
  // E8: only an estimate this edit changes is checked against the scale.
  if (changes.estimate !== undefined) checkEstimate(team, after.estimate);

  // Only the fields that change, so a concurrent edit of another field keeps its value (NFR-07).
  const patch: ModelPatch<'Issue'> = {
    ...(changes.title && { title: after.title }),
    ...(changes.statusId && { statusId: after.statusId }),
    ...(changes.priority && { priority: after.priority }),
    ...(changes.assigneeId && { assigneeId: after.assigneeId }),
    ...(changes.labelIds && { labelIds: after.labelIds }),
    ...(changes.estimate && { estimate: after.estimate }),
    ...(changes.dueDate && { dueDate: after.dueDate }),
  };
  if (status !== undefined && changes.statusId !== undefined) {
    const from = await access.statusCategory(issue.statusId);
    const stamps = statusSideEffects<Date>(from ?? null, status.category, now, issue);
    checkInv20(stamps, status.category);
    if (stamps.startedAt !== issue.startedAt) patch.startedAt = stamps.startedAt;
    if (stamps.completedAt !== issue.completedAt) patch.completedAt = stamps.completedAt;
    if (stamps.canceledAt !== issue.canceledAt) patch.canceledAt = stamps.canceledAt;
  }
  const row = await repo.update('Issue', issue.id, patch);
  ctx.emit({ type: 'issue.updated', subject: { type: 'issue', id: issue.id }, changes });
  return { row, changes };
}
