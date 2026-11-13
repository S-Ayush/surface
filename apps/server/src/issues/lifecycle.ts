/**
 * `lockIssueForWrite` (SPEC-011 §4.8, SPEC-015 §4.4): the one way an issue write, or a write to
 * one of its children, starts. It locks the issue row, reads its lifecycle state, and applies the
 * mode's rule. Each handler takes its mode from the lifecycle rule table (`issueLockModeOf`,
 * `packages/domain/src/issue-lifecycle.ts`), and `issue-lifecycle-table.test.ts` checks it does.
 *
 * Lock order (SPEC-011 §4.8): workspace row → team row → status and label rows → issue rows in
 * ascending id → thread root comment. The caller takes anything before the issue first. This
 * helper reads no team row while it holds the lock, except to word a refusal, which rolls the
 * transaction back anyway.
 */
import {
  issueIdentifier,
  lifecycleOf,
  lifecycleRefusal,
  lockRefusal,
  type Actor,
  type IssueLifecycle,
  type IssueLockMode,
} from '@surface/domain';
import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { issues, teams } from '../db/schema/index.js';
import type { HandlerContext } from '../executor/context.js';
import { refNotFound } from '../executor/refs/resolve.js';
import { SurfaceError } from '../executor/errors.js';
import { visibleTo } from '../executor/list.js';
import type { ModelName, ModelRow } from '../sync/models.js';

/**
 * - `edit`: a direct edit by a user, API or MCP actor. Archived or deleted is `CONFLICT`
 *   (SPEC-015 §4.3), even for an edit that would change nothing (SPEC-011 E12).
 * - `lifecycle`: delete, restore, purge. Returns the state; the handler applies SPEC-015 §4.2.
 * - `cascade`: settings cascades and system jobs. No lifecycle check.
 */
export type { IssueLockMode };

/** The locked issue row and its lifecycle state, so the handler re-reads nothing it holds. */
export type LockedIssue = ModelRow<'Issue'> & { readonly state: IssueLifecycle };

/**
 * Locks issue `issueId` (`SELECT … FOR UPDATE`) as `ctx.actor` sees it: filtered by its sync
 * groups and its API key's teams, so a missing or invisible issue is `NOT_FOUND`, worded like an
 * `IssueRef` that matches nothing (SPEC-011 E13), at `ctx.path` (default `['issue']`, the
 * input field most operations name it by). Then applies `mode`.
 */
export async function lockIssueForWrite(
  tx: NodePgDatabase,
  issueId: string,
  ctx: { readonly actor: Actor; readonly path?: readonly (string | number)[] },
  mode: IssueLockMode,
): Promise<LockedIssue> {
  const [issue] = await tx
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), visibleTo(ctx.actor, issues.syncGroups, issues.teamId)))
    .for('update');
  if (!issue) throw refNotFound('IssueRef', issueId, ctx.path ?? ['issue']);
  const state = lifecycleOf(issue);
  const refused = lockRefusal(mode, state);
  if (refused !== undefined) {
    throw new SurfaceError('CONFLICT', lifecycleRefusal(await identifierOf(tx, issue), refused));
  }
  return { ...issue, state };
}

/**
 * `ENG-42`, for a refusal message. A plain read (no lock), after the issue lock: only a refusal
 * reads it, and the refusal rolls the transaction back anyway (SPEC-011 §4.8).
 */
export async function identifierOf(
  tx: NodePgDatabase,
  issue: { readonly teamId: string; readonly number: number | null },
): Promise<string> {
  const [team] = await tx.select({ key: teams.key }).from(teams).where(eq(teams.id, issue.teamId));
  // `number` is never null on the server (issues_number_check); the fallback only types it.
  return team && issue.number !== null ? issueIdentifier(team.key, issue.number) : 'This issue';
}

// ---------------------------------------------------------------------------------------------
// Restore re-logs the issue's eager children (SPEC-015 §5.1, AC-21)

/** At most this many rows of one model per issue are logged again (SPEC-014 D20: 100 attachments). */
export const RESTORE_RELOG_LIMIT = 100;

/**
 * An eager child model of issues that the client drops with its issue (SPEC-011 §5.7), so a
 * restore must log its rows again: one `U` each, through `repo.updateWhere` with an empty patch
 * and `touchUpdatedAt: false`, after the Issue's `V` or `U` and in the same transaction.
 */
export interface RestoreRelogStep {
  readonly model: ModelName;
  /** The ids of the issue's rows of `model`, ascending, at most `limit`. */
  ids(tx: NodePgDatabase, issueId: string, limit: number): Promise<string[]>;
}

/**
 * The registered steps. Empty until PLAN-014 S4a adds the Attachment model and appends its step
 * here (append-only, like the purge steps of PLAN-015 S2).
 */
export const RESTORE_RELOG_STEPS: readonly RestoreRelogStep[] = [];

/** A step for a model whose table has an `issue_id` column, for PLAN-014 S4a's Attachment. */
export function relogByIssueId(
  model: ModelName,
  table: { readonly id: AnyPgColumn; readonly issueId: AnyPgColumn } & PgTable,
): RestoreRelogStep {
  return {
    model,
    async ids(tx, issueId, limit) {
      const rows = await tx
        .select({ id: table.id })
        .from(table)
        .where(eq(table.issueId, issueId))
        .orderBy(asc(table.id))
        .limit(limit);
      return rows.flatMap((row) => (typeof row.id === 'string' ? [row.id] : []));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// History of lifecycle transitions (SPEC-015 §4.8)

/** The history kinds of a lifecycle transition (SPEC-015 §4.8); never folded, `changes` empty. */
export type LifecycleHistoryKind = 'deleted' | 'restored';

/**
 * Writes the `deleted` or `restored` history entry of `issue`'s transition, in `ctx`'s
 * transaction, as `ctx.actor` (its kind and key). Nothing writes IssueHistory content until
 * PLAN-011 S6: its history writer (`issues/history.ts`) replaces this body with one insert through
 * `ctx.repo`, never folded, with empty `changes`. The handlers already call it with every argument.
 */
export function writeLifecycleHistory(
  _ctx: HandlerContext,
  _kind: LifecycleHistoryKind,
  _issue: ModelRow<'Issue'>,
): Promise<void> {
  // TODO(PLAN-011 S6): insert the IssueHistory row through `ctx.repo`.
  return Promise.resolve();
}
