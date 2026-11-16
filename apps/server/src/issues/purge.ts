/**
 * Purging an issue (SPEC-015 §4.5), in the operation's one transaction, through the repo layer:
 *
 * 1. `lockIssueForWrite` in `lifecycle` mode. A missing or invisible issue is `NOT_FOUND`; a live
 *    or archived one is `CONFLICT` "Delete ENG-42 first." (§4.2), with nothing written.
 * 2. Every registered purge step (`purge-steps.ts`), children before parents. Content rows log no
 *    `D` (ADR-0022); `flush` checks that the Issue's own `D` sits next to them.
 * 3. The Issue row, with a logged `D`.
 * 4. The audit line and the `issue.purged` event, both written only if the transaction commits.
 *
 * The team's issue counter is never touched, so a purged number is never reused (INV-08). Purge
 * writes no history: the history goes with the issue (§4.8).
 *
 * The issue lock comes first and is the only lock the purge takes itself, so a comment insert
 * racing it waits on the row lock and then finds no issue (E16): no child row can appear after a
 * step ran. The `issue.purge` handler and the `trash-purge` job (as the system actor, through the
 * executor) both run this.
 */
import {
  issueLockModeOf,
  lifecycleRefusal,
  lifecycleStep,
  type Actor,
  type IssueLockMode,
} from '@surface/domain';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { DomainEvent, HandlerContext } from '../executor/context.js';
import { SurfaceError } from '../executor/errors.js';
import type { Repo } from '../sync/repo.js';
import type { LockedIssue } from './lifecycle.js';
import { PURGE_STEPS, type PurgeStep } from './purge-steps.js';

/** The reads a purge takes, in the operation's transaction (`LifecycleAccess` has both). */
export interface PurgeAccess {
  /** `lockIssueForWrite` in `mode`. */
  lockIssue(issueId: string, mode: IssueLockMode): Promise<LockedIssue>;
  /** `ENG-42`, for a refusal (a plain read; the transaction then rolls back). */
  identifier(issue: LockedIssue): Promise<string>;
}

export interface PurgeContext {
  readonly access: PurgeAccess;
  /** The transaction the steps run their server-only deletes in. */
  readonly tx: NodePgDatabase;
  readonly repo: Repo;
  readonly actor: Actor;
  readonly now: Date;
  readonly emit: (event: DomainEvent) => void;
  readonly audit: HandlerContext['audit'];
  /** The registry; tests pass their own. */
  readonly steps?: readonly PurgeStep[];
}

/** What was purged: the issue's id, team and number (never its title). */
export interface PurgedIssue {
  readonly id: string;
  readonly teamId: string;
  readonly number: number | null;
}

/** `issue.purge`: Deleted → Purged; Live or Archived → `CONFLICT` (§4.2). */
export async function purgeIssue(ctx: PurgeContext, issueId: string): Promise<PurgedIssue> {
  const { access, repo } = ctx;
  const issue = await access.lockIssue(issueId, issueLockModeOf('issue.purge'));
  const step = lifecycleStep('purge', issue, ctx.now, ctx.now);
  if (step.kind === 'conflict') {
    throw new SurfaceError(
      'CONFLICT',
      lifecycleRefusal(await access.identifier(issue), step.conflict),
    );
  }
  if (step.kind !== 'purged') throw new Error(`issue.purge cannot ${step.kind}`);

  for (const purge of ctx.steps ?? PURGE_STEPS) await purge.step(ctx.tx, repo, issue.id);
  await repo.purge('Issue', issue.id);

  const purged: PurgedIssue = { id: issue.id, teamId: issue.teamId, number: issue.number };
  ctx.audit(
    'issue.purged',
    {
      issueId: purged.id,
      teamId: purged.teamId,
      ...(purged.number === null ? {} : { number: purged.number }),
      // Null for the system actor (the `trash-purge` job); the key's owner for `api` and `mcp`.
      ...(ctx.actor.userId === undefined ? {} : { actorId: ctx.actor.userId }),
    },
    'issue purged',
  );
  ctx.emit({
    type: 'issue.purged',
    subject: { type: 'issue', id: purged.id },
    data: { teamId: purged.teamId, number: purged.number },
  });
  return purged;
}
