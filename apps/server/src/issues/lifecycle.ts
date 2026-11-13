/**
 * `lockIssueForWrite` (SPEC-011 §4.8, SPEC-015 §4.4): the one way an issue write, or a write to
 * one of its children, starts. It locks the issue row, reads its lifecycle state, and applies the
 * mode's rule. PLAN-015 S1 adds the lifecycle rule table behind `lifecycle`.
 *
 * Lock order (SPEC-011 §4.8): workspace row → team row → status and label rows → issue rows in
 * ascending id → thread root comment. The caller takes anything before the issue first. This
 * helper reads no team row while it holds the lock, except to word a refusal, which rolls the
 * transaction back anyway.
 */
import {
  editRefusal,
  issueIdentifier,
  lifecycleOf,
  type Actor,
  type IssueLifecycle,
} from '@surface/domain';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { issues, teams } from '../db/schema/index.js';
import { refNotFound } from '../executor/refs/resolve.js';
import { SurfaceError } from '../executor/errors.js';
import { visibleTo } from '../executor/list.js';
import type { ModelRow } from '../sync/models.js';

/**
 * - `edit`: a direct edit by a user, API or MCP actor. Archived or deleted is `CONFLICT`
 *   (SPEC-015 §4.3), even for an edit that would change nothing (SPEC-011 E12).
 * - `lifecycle`: delete, restore, purge. Returns the state; the handler applies SPEC-015 §4.2.
 * - `cascade`: settings cascades and system jobs. No lifecycle check.
 */
export type IssueLockMode = 'edit' | 'lifecycle' | 'cascade';

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
  if (mode === 'edit' && state !== 'live') {
    const message = editRefusal(await identifierOf(tx, issue), state);
    if (message !== undefined) throw new SurfaceError('CONFLICT', message);
  }
  return { ...issue, state };
}

/** `ENG-42`, for a refusal message. A plain read (no lock): the transaction is about to fail. */
async function identifierOf(
  tx: NodePgDatabase,
  issue: { readonly teamId: string; readonly number: number | null },
): Promise<string> {
  const [team] = await tx.select({ key: teams.key }).from(teams).where(eq(teams.id, issue.teamId));
  // `number` is never null on the server (issues_number_check); the fallback only types it.
  return team && issue.number !== null ? issueIdentifier(team.key, issue.number) : 'This issue';
}
