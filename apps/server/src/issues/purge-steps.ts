/**
 * The purge-step registry (SPEC-015 §4.5): what purging an issue deletes besides the issue row,
 * in order. PLAN-015 S2 owns the registry and the purge that runs it; PLAN-013 S3 created this
 * file with the type and registered the comment steps, because it merged first.
 *
 * Content rows (Comment, Reaction: parent `Issue`) are deleted with
 * `repo.deleteWhere(…, { log: LOG_CONTENT_DELETES })` (ADR-0022): the purge logs the issue's own
 * `D`, which drops its content on every client, so the content rows log nothing. The repo refuses
 * an unlogged delete on any field but the parent's (`issueId`), and `flush` refuses one whose
 * issue is not deleted, with a logged `D`, in the same transaction. Server-only tables are plain
 * deletes.
 */
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ModelName } from '../sync/models.js';
import type { Repo } from '../sync/repo.js';

/** ADR-0022: an issue's content rows are purged unlogged. Never true for a step here. */
export const LOG_CONTENT_DELETES = false;

export interface PurgeStep {
  /** The synced model the step deletes, or a server-only table's name. */
  readonly model: ModelName | `table:${string}`;
  /** Deletes the issue's rows of `model`, inside the purge's transaction. */
  step(tx: NodePgDatabase, repo: Repo, issueId: string): Promise<void>;
}

/**
 * SPEC-013 §4.3: reactions, then comments, then `comment_search_text`. Every foreign key from
 * `reactions` and `comments` is `ON DELETE RESTRICT`, so reactions go before the comments they
 * name. A reply references its root by `comments_parent_comment_id_fk`, also RESTRICT: one
 * `DELETE` statement removing both is fine (Postgres checks RESTRICT at the end of the statement),
 * but `deleteWhere` deletes in chunks of ids, so a thread split across two chunks with its root in
 * the earlier one would fail. Follow-up for PLAN-015 S2: order the comment deletes replies first
 * (or test the chunk boundary) before an issue can have more comments than one chunk.
 */
export const COMMENT_PURGE_STEPS: readonly PurgeStep[] = [
  {
    model: 'Reaction',
    step: async (_tx, repo, issueId) => {
      await repo.deleteWhere('Reaction', 'issueId', [issueId], { log: LOG_CONTENT_DELETES });
    },
  },
  {
    model: 'Comment',
    step: async (_tx, repo, issueId) => {
      await repo.deleteWhere('Comment', 'issueId', [issueId], { log: LOG_CONTENT_DELETES });
    },
  },
  {
    // Server-only (D2). Its foreign key cascades from `comments`, so after the step above this
    // finds nothing; it stays as the registered step so the purge never depends on the cascade.
    model: 'table:comment_search_text',
    step: async (tx, _repo, issueId) => {
      await tx.execute(
        sql`DELETE FROM comment_search_text t USING comments c
            WHERE c.id = t.comment_id AND c.issue_id = ${issueId}`,
      );
    },
  },
];

/** Every registered step, in the order the purge runs them (SPEC-015 §4.5). */
export const PURGE_STEPS: readonly PurgeStep[] = [...COMMENT_PURGE_STEPS];
