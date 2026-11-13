/**
 * The rules of `issue.delete` and `issue.restore` (SPEC-015 §4.2, §4.8, §5.1, §6.4), written
 * against `LifecycleAccess` (the issue lock and two plain reads) and the repo, so the unit tests
 * run them in memory, with interleaved fake transactions, while the handlers run them on Postgres.
 *
 * Lock order (SPEC-011 §4.8): the issue row is the only lock, taken first in `lifecycle` mode
 * (the table's mode for both operations). Both read nothing they don't hold: the lock returns the
 * row, and the transition is `lifecycleStep` on it. Two of them on one issue therefore run one
 * after the other, and the second sees what the first committed (E3).
 *
 * Idempotence (§4.2): deleting a deleted issue, or restoring a live one, writes nothing, records
 * no history and emits no event.
 */
import {
  issueLockModeOf,
  lifecycleRefusal,
  lifecycleStep,
  type Actor,
  type IssueLockMode,
} from '@surface/domain';
import type { DomainEvent } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import {
  RESTORE_RELOG_LIMIT,
  type LifecycleHistoryKind,
  type LockedIssue,
} from '../../issues/lifecycle.js';
import type { ModelName } from '../../sync/models.js';
import type { Repo } from '../../sync/repo.js';
import type { IssueRow } from './core.js';

/** Reads and locks. Every method runs in the operation's transaction. */
export interface LifecycleAccess {
  /** `lockIssueForWrite` in `mode`. */
  lockIssue(issueId: string, mode: IssueLockMode): Promise<LockedIssue>;
  /** `ENG-42`, for a refusal (a plain read; the transaction then rolls back). */
  identifier(issue: LockedIssue): Promise<string>;
  /**
   * The issue's rows of each eager child model a restore logs again (SPEC-015 §5.1), ascending
   * by id. Empty until PLAN-014 S4a registers Attachment.
   */
  relogRows(issueId: string): Promise<readonly RelogRows[]>;
}

export interface RelogRows {
  readonly model: ModelName;
  readonly ids: readonly string[];
}

export interface LifecycleContext {
  readonly access: LifecycleAccess;
  readonly repo: Repo;
  readonly actor: Actor;
  readonly now: Date;
  readonly emit: (event: DomainEvent) => void;
  /** Writes one history entry of `kind` for the issue, in this transaction (§4.8). */
  readonly history: (kind: LifecycleHistoryKind, issue: IssueRow) => Promise<void>;
}

export interface LifecycleResult {
  /** The issue as stored afterwards. */
  readonly row: IssueRow;
  /** False for a no-op: nothing was written, recorded or emitted. */
  readonly changed: boolean;
}

/** Without the lock's `state`, so outputs and tests see the stored row only. */
function stored(issue: LockedIssue): IssueRow {
  const { state: _state, ...row } = issue;
  return row;
}

function event(type: string, row: IssueRow): DomainEvent {
  return {
    type,
    subject: { type: 'issue', id: row.id },
    data: { teamId: row.teamId, number: row.number },
  };
}

/** `issue.delete`: Live or Archived → Deleted, keeping `archivedAt` until a restore (§4.2). */
export async function deleteIssue(
  ctx: LifecycleContext,
  issueId: string,
): Promise<LifecycleResult> {
  const issue = await ctx.access.lockIssue(issueId, issueLockModeOf('issue.delete'));
  const step = lifecycleStep('delete', issue, ctx.now, ctx.now);
  if (step.kind === 'noop') return { row: stored(issue), changed: false };
  if (step.kind !== 'moves') throw new Error(`issue.delete cannot ${step.kind}`);
  // One `U` with the full row; the client drops the issue on it (SPEC-015 §5.1). The system
  // actor has no user, so it leaves `deletedById` null (§4.1).
  const row = await ctx.repo.update('Issue', issue.id, {
    deletedAt: step.stamps.deletedAt,
    deletedById: ctx.actor.userId ?? null,
  });
  await ctx.history('deleted', row);
  ctx.emit(event('issue.deleted', row));
  return { row, changed: true };
}

/**
 * `issue.restore`: Archived or Deleted → Live, clearing both (D12), only before `purgeAfter` for
 * a deleted issue (E4). Sets `updatedAt` to now, so the auto-archive job leaves it alone for a
 * full period (E20). Logs `V` for `archivedAt` and `U` for `deletedAt` (both for an issue that is
 * both), then a `U` per row of each eager child the client dropped with the issue (AC-21).
 */
export async function restoreIssue(
  ctx: LifecycleContext,
  issueId: string,
): Promise<LifecycleResult> {
  const { access, repo } = ctx;
  const issue = await access.lockIssue(issueId, issueLockModeOf('issue.restore'));
  const step = lifecycleStep('restore', issue, ctx.now, ctx.now);
  if (step.kind === 'noop') return { row: stored(issue), changed: false };
  if (step.kind === 'conflict') {
    throw new SurfaceError(
      'CONFLICT',
      lifecycleRefusal(await access.identifier(issue), step.conflict),
    );
  }
  if (step.kind !== 'moves') throw new Error(`issue.restore cannot ${step.kind}`);

  let row = stored(issue);
  // `unarchive` logs `V` and sets `updatedAt`; `update` logs `U` and sets it too.
  if (issue.archivedAt !== null) row = await repo.unarchive('Issue', issue.id);
  if (issue.deletedAt !== null) {
    row = await repo.update('Issue', issue.id, { deletedAt: null, deletedById: null });
  }
  for (const { model, ids } of await access.relogRows(issue.id)) {
    // An empty patch writes nothing and logs each row again, as stored (SPEC-011 §5.1); at most
    // `RESTORE_RELOG_LIMIT` per model (SPEC-014 D20 caps an issue at 100 attachments).
    const capped = ids.slice(0, RESTORE_RELOG_LIMIT);
    if (capped.length > 0) await repo.updateWhere(model, capped, {}, { touchUpdatedAt: false });
  }
  await ctx.history('restored', row);
  ctx.emit(event('issue.restored', row));
  return { row, changed: true };
}
