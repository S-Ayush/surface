/**
 * The rules of `issue.autoArchive` and `issue.autoClose` (SPEC-015 §6.3, §4.8, §6.4), written
 * against `AutoAccess` (the team and status locks and the issue lock) and the repo, so the unit
 * tests run them in memory while the handlers run them on Postgres. The jobs call both operations
 * as the system actor, one issue per transaction.
 *
 * Lock order (SPEC-011 §4.8): team row `FOR SHARE` (the settings are stable, because
 * `team.updateAutomations` takes it `FOR UPDATE`), the auto-close status `FOR KEY SHARE`, then
 * the issue row in `lifecycle` mode (the table's mode for both). The issue's own columns and its
 * status are then read, and the issue is checked again against the team's setting at the
 * operation's clock: one edited, restored or closed after the job selected it is `CONFLICT`,
 * which the job counts as skipped (E21, E20).
 */
import {
  autoArchiveDueAt,
  autoCloseDueAt,
  CLOSED_CATEGORIES,
  inv20Problem,
  issueChangeSet,
  issueLockModeOf,
  lifecycleStep,
  statusSideEffects,
  type IssueChangeSet,
  type IssueLockMode,
  type StatusCategory,
} from '@surface/domain';
import type { DomainEvent } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import type { LifecycleHistoryKind, LockedIssue } from '../../issues/lifecycle.js';
import type { Repo } from '../../sync/repo.js';
import type { IssueRow } from './core.js';

/** What the jobs' operations read of a team: its settings, under the row lock. */
export interface AutomationSettings {
  readonly autoArchiveMonths: number;
  readonly autoCloseMonths: number | null;
  readonly autoCloseStatusId: string | null;
}

export interface AutoStatus {
  readonly id: string;
  readonly teamId: string;
  readonly category: StatusCategory;
}

export interface AutoAccess {
  /** The team's settings, the row `FOR SHARE`; undefined when it is gone. */
  shareTeam(teamId: string): Promise<AutomationSettings | undefined>;
  /** The status `FOR KEY SHARE`; undefined when it is gone. */
  shareStatus(statusId: string): Promise<AutoStatus | undefined>;
  /** `lockIssueForWrite` in `mode`. */
  lockIssue(issueId: string, mode: IssueLockMode): Promise<LockedIssue>;
  /** A status's category, a plain read (the locked issue's current status). */
  statusCategory(statusId: string): Promise<StatusCategory | undefined>;
  /** `ENG-42`, for a refusal. */
  identifier(issue: LockedIssue): Promise<string>;
}

export interface AutoContext {
  readonly access: AutoAccess;
  readonly repo: Repo;
  readonly now: Date;
  readonly emit: (event: DomainEvent) => void;
  /** The `archived` entry (§4.8), once per real transition. */
  readonly history: (kind: LifecycleHistoryKind, issue: IssueRow) => Promise<void>;
  /** The auto-close `updated` entry with the status change (§4.8), once per real transition. */
  readonly closeHistory: (issue: IssueRow, changes: IssueChangeSet) => Promise<void>;
}

const OPEN_CATEGORIES: readonly StatusCategory[] = ['backlog', 'unstarted', 'started'];

function conflict(message: string): SurfaceError {
  return new SurfaceError('CONFLICT', message);
}

/** `issue.autoArchive`: a live, closed issue past its team's period → Archived (§4.2, §6.3). */
export async function autoArchiveIssue(
  ctx: AutoContext,
  target: { readonly issueId: string; readonly teamId: string },
): Promise<IssueRow> {
  const { access, repo, now } = ctx;
  const settings = await access.shareTeam(target.teamId);
  const issue = await access.lockIssue(target.issueId, issueLockModeOf('issue.autoArchive'));
  const name = await access.identifier(issue);
  const step = lifecycleStep('autoArchive', issue, now, now);
  if (step.kind !== 'moves') throw conflict(`${name} is no longer live, so it was not archived.`);
  const category = await access.statusCategory(issue.statusId);
  const due =
    settings !== undefined && category !== undefined && CLOSED_CATEGORIES.has(category)
      ? autoArchiveDueAt(issue, settings.autoArchiveMonths)
      : undefined;
  if (due === undefined || now.getTime() < due.getTime()) {
    throw conflict(`${name} is not due to be archived.`);
  }
  const row = await repo.archive('Issue', issue.id);
  await ctx.history('archived', row);
  ctx.emit({
    type: 'issue.archived',
    subject: { type: 'issue', id: row.id },
    data: { teamId: row.teamId, number: row.number },
  });
  return row;
}

/** `issue.autoClose`: a live, stale issue → the team's auto-close status (§4.6, §6.3). */
export async function autoCloseIssue(
  ctx: AutoContext,
  target: { readonly issueId: string; readonly teamId: string },
): Promise<IssueRow> {
  const { access, repo, now } = ctx;
  const settings = await access.shareTeam(target.teamId);
  if (
    settings === undefined ||
    settings.autoCloseMonths === null ||
    settings.autoCloseStatusId === null
  ) {
    throw conflict('Auto-close is off for this team.');
  }
  const status = await access.shareStatus(settings.autoCloseStatusId);
  if (status === undefined || status.teamId !== target.teamId || status.category !== 'canceled') {
    throw conflict(
      "This team's auto-close status is not a Canceled status. Choose another one in Automations.",
    );
  }
  const issue = await access.lockIssue(target.issueId, issueLockModeOf('issue.autoClose'));
  const name = await access.identifier(issue);
  const step = lifecycleStep('autoArchive', issue, now, now);
  if (step.kind !== 'moves') throw conflict(`${name} is no longer live, so it was not closed.`);
  const from = await access.statusCategory(issue.statusId);
  if (
    from === undefined ||
    !OPEN_CATEGORIES.includes(from) ||
    now.getTime() < autoCloseDueAt(issue, settings.autoCloseMonths).getTime()
  ) {
    throw conflict(`${name} is not stale.`);
  }

  // The category side effects of SPEC-011 §4.6: Canceled sets `canceledAt`, keeps `startedAt`.
  const stamps = statusSideEffects<Date>(from, status.category, now, issue);
  const problem = inv20Problem(stamps, status.category);
  // A bug, never bad input: the side effects always satisfy INV-20 (domain property test).
  if (problem !== undefined) throw new Error(`INV-20 broken: ${problem}`);
  const changes = issueChangeSet(issue, { ...issue, statusId: status.id });
  const row = await repo.update('Issue', issue.id, {
    statusId: status.id,
    ...(stamps.startedAt !== issue.startedAt && { startedAt: stamps.startedAt }),
    ...(stamps.completedAt !== issue.completedAt && { completedAt: stamps.completedAt }),
    ...(stamps.canceledAt !== issue.canceledAt && { canceledAt: stamps.canceledAt }),
  });
  await ctx.closeHistory(row, changes);
  ctx.emit({ type: 'issue.updated', subject: { type: 'issue', id: issue.id }, changes });
  return row;
}
