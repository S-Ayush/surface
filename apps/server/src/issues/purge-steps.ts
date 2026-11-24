/**
 * The purge-step registry (SPEC-015 §4.5): what purging an issue deletes besides the issue row,
 * in order. PLAN-015 S2 owns the registry and the purge that runs it (`issues/purge.ts`);
 * PLAN-013 S3 created this file with the type and registered the comment steps, because it
 * merged first.
 *
 * Every table with a foreign key to `issues` needs a step here, in the change that adds the table
 * (`purge-steps.test.ts` reads the Drizzle schema and fails otherwise). The one exception is the
 * server-only `issue_search_text`, whose key cascades (D19).
 *
 * Attachments are eager rows, deleted with a logged `D` each; the issue's `files` rows go through
 * the byte protocol (PLAN-014 S4a).
 *
 * Content rows (IssueContent, IssueHistory, Comment, Reaction: parent `Issue`) are deleted with
 * `repo.deleteWhere(…, { log: LOG_CONTENT_DELETES })` (ADR-0022): the purge logs the issue's own
 * `D`, which drops its content on every client, so the content rows log nothing. The repo refuses
 * an unlogged delete on any field but the parent's (`issueId`), and `flush` refuses one whose
 * issue is not deleted, with a logged `D`, in the same transaction. Server-only tables are plain
 * deletes.
 */
import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { files } from '../db/schema/index.js';
import { deleteFiles, type FileTx } from '../files/bytes.js';
import type { ModelName } from '../sync/models.js';
import type { Repo } from '../sync/repo.js';

/** ADR-0022: an issue's content rows are purged unlogged. Never true for a step here. */
export const LOG_CONTENT_DELETES = false;

export interface PurgeStep {
  /** The synced model the step deletes, or a server-only table's name. */
  readonly model: ModelName | `table:${string}`;
  /**
   * Deletes the issue's rows of `model`, inside the purge's transaction. `files` is the byte
   * protocol on that transaction's connection (SPEC-014 §4.5), for the step that deletes the
   * issue's `files` rows.
   */
  step(tx: NodePgDatabase, repo: Repo, issueId: string, files: FileTx): Promise<void>;
}

/**
 * SPEC-013 §4.3: reactions, then `comment_search_text`, then comments, replies before roots.
 * Every foreign key from `reactions` and `comments` is `ON DELETE RESTRICT`, so reactions go
 * before the comments they name. The search text goes before the comments: its key cascades from
 * them, so afterwards it would find nothing and the step would only look like it ran. A reply
 * references its root by a RESTRICT key too, and `deleteWhere` deletes in chunks, so the comment
 * step orders replies first (`childrenFirst`): no chunk deletes a root whose reply is still there.
 */
export const COMMENT_PURGE_STEPS: readonly PurgeStep[] = [
  {
    model: 'Reaction',
    step: async (_tx, repo, issueId) => {
      await repo.deleteWhere('Reaction', 'issueId', [issueId], { log: LOG_CONTENT_DELETES });
    },
  },
  {
    // Server-only (D2).
    model: 'table:comment_search_text',
    step: async (tx, _repo, issueId) => {
      await tx.execute(
        sql`DELETE FROM comment_search_text t USING comments c
            WHERE c.id = t.comment_id AND c.issue_id = ${issueId}`,
      );
    },
  },
  {
    model: 'Comment',
    step: async (_tx, repo, issueId) => {
      await repo.deleteWhere('Comment', 'issueId', [issueId], {
        log: LOG_CONTENT_DELETES,
        childrenFirst: 'parentCommentId',
      });
    },
  },
];

/**
 * SPEC-011's content children (PLAN-015 S2): the activity, then the description. Nothing else
 * references either, so their order is free; §4.5 lists them last, after the attachments.
 */
export const ISSUE_CONTENT_PURGE_STEPS: readonly PurgeStep[] = [
  {
    model: 'IssueHistory',
    step: async (_tx, repo, issueId) => {
      await repo.deleteWhere('IssueHistory', 'issueId', [issueId], { log: LOG_CONTENT_DELETES });
    },
  },
  {
    model: 'IssueContent',
    step: async (_tx, repo, issueId) => {
      await repo.deleteWhere('IssueContent', 'issueId', [issueId], { log: LOG_CONTENT_DELETES });
    },
  },
];

/**
 * SPEC-014 §4.7 (PLAN-014 S4a): the issue's attachments, then every `files` row it owns.
 *
 * - Attachments are eager rows: one logged `D` each (SPEC-015 §5.1), so a client that still holds
 *   one drops it. They go before the files their RESTRICT keys name.
 * - The files: every row with this `issue_id` (attachments, detached or not, and inline files),
 *   and their previews (`issue_id` null, found by `preview_of`), through the byte protocol's
 *   `deleteFiles` (§4.5 step 4): the rows and previews locked `FOR UPDATE`, after the issue lock
 *   the purge took first, then every key; previews deleted before their sources; the keys into
 *   `blob_release`. No bytes are unlinked here: `files-cleanup` drains the keys after commit, and
 *   keeps bytes another row still names. Server-only rows: nothing is logged.
 */
export const ATTACHMENT_PURGE_STEPS: readonly PurgeStep[] = [
  {
    model: 'Attachment',
    step: async (_tx, repo, issueId) => {
      await repo.deleteWhere('Attachment', 'issueId', [issueId]);
    },
  },
  {
    model: 'table:files',
    step: async (tx, _repo, issueId, fileTx) => {
      const owned = await tx
        .select({ id: files.id })
        .from(files)
        .where(eq(files.issueId, issueId))
        .orderBy(asc(files.id));
      if (owned.length > 0)
        await deleteFiles(
          fileTx,
          owned.map((row) => row.id),
        );
    },
  },
];

/**
 * Every registered step, in the order the purge runs them (SPEC-015 §4.5): reactions and comments,
 * then attachments and the issue's `files` rows, then history and content. A step runs before the
 * step of any table it references (`purge-steps.test.ts`).
 */
export const PURGE_STEPS: readonly PurgeStep[] = [
  ...COMMENT_PURGE_STEPS,
  ...ATTACHMENT_PURGE_STEPS,
  ...ISSUE_CONTENT_PURGE_STEPS,
];
