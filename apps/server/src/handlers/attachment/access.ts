/**
 * `AttachmentAccess` over the operation's Postgres transaction, and the attachment output shapes
 * (SPEC-014 §6.2). `files` is server-only, so its two updates (claim, detach) are plain SQL in the
 * operation's transaction; `attachments` is synced and written only through `ctx.repo`.
 *
 * The rows an output names (issue, creator, files) are visible to whoever sees the attachment:
 * its issue (an attachment is visible only through it), users (workspace-wide), and the file and
 * its preview, which belong to the issue (§4.2).
 */
import type { RefEntity } from '@surface/domain';
import type { AttachmentOutputSchema, AttachmentSummarySchema } from '@surface/operations';
import { and, asc, count, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { z } from 'zod';
import { attachments, files, issues, users } from '../../db/schema/index.js';
import type { HandlerContext } from '../../executor/context.js';
import { historyWriteContext } from '../../issues/history.js';
import { identifierOf, lockIssueForWrite } from '../../issues/lifecycle.js';
import { resolved } from '../teams/shared.js';
import type {
  AttachmentAccess,
  AttachmentRow,
  AttachmentTarget,
  AttachmentWriteContext,
} from './core.js';

type AttachmentSummary = z.input<typeof AttachmentSummarySchema>;
type AttachmentOutput = z.input<typeof AttachmentOutputSchema>;

export function attachmentAccess(ctx: HandlerContext): AttachmentAccess {
  const { tx } = ctx;
  return {
    lockIssue: (issueId, mode) => lockIssueForWrite(tx, issueId, { actor: ctx.actor }, mode),
    async countOnIssue(issueId) {
      const [row] = await tx
        .select({ n: count() })
        .from(attachments)
        .where(eq(attachments.issueId, issueId));
      return row?.n ?? 0;
    },
    async lockAttachment(id) {
      const [row] = await tx.select().from(attachments).where(eq(attachments.id, id)).for('update');
      return row;
    },
    async claimFile(fileId, issueId, userId) {
      // One conditional update (§6.2): a concurrent claim of the same upload waits on the row
      // lock and then matches nothing, so a file is never claimed twice.
      const [row] = await tx
        .update(files)
        .set({ issueId, detachedAt: null })
        .where(
          and(
            eq(files.id, fileId),
            eq(files.purpose, 'attachment'),
            or(
              and(isNull(files.issueId), eq(files.uploaderId, userId)),
              and(eq(files.issueId, issueId), isNotNull(files.detachedAt)),
            ),
          ),
        )
        .returning({
          id: files.id,
          name: files.name,
          mimeType: files.mimeType,
          size: files.size,
          width: files.width,
          height: files.height,
        });
      return row;
    },
    async detachFile(fileId, at) {
      await tx.update(files).set({ detachedAt: at }).where(eq(files.id, fileId));
    },
    async isPreviewOf(fileId, sourceId) {
      const [row] = await tx
        .select({ id: files.id })
        .from(files)
        .where(
          and(eq(files.id, fileId), eq(files.purpose, 'preview'), eq(files.previewOf, sourceId)),
        );
      return row !== undefined;
    },
  };
}

/** The write context the attachment rules run with. */
export function attachmentWriteContext(ctx: HandlerContext): AttachmentWriteContext {
  return {
    access: attachmentAccess(ctx),
    repo: ctx.repo,
    history: historyWriteContext(ctx),
    emit: (event) => ctx.emit(event),
    now: ctx.now(),
  };
}

/** The attachment a resolved `AttachmentRef` names; `ref` is the input as given. */
export function attachmentTargetOf(ctx: HandlerContext, ref: string): AttachmentTarget {
  const row: RefEntity = resolved(ctx.refs['attachment'], 'attachment');
  const issueId = row['issueId'];
  if (typeof issueId !== 'string') throw new Error('Attachment reference is missing issueId');
  return { attachmentId: row.id, issueId, ref };
}

/** `GET /files/:id` on `SURFACE_URL`. */
function fileUrl(publicUrl: string, fileId: string | null): string | null {
  return fileId === null ? null : `${publicUrl.replace(/\/+$/, '')}/files/${fileId}`;
}

/** The summary of each row, in the rows' order (§6.2): what `issue.get` lists. */
export async function attachmentSummaries(
  ctx: Pick<HandlerContext, 'tx' | 'publicUrl'>,
  rows: readonly AttachmentRow[],
): Promise<AttachmentSummary[]> {
  if (rows.length === 0) return [];
  const { tx, publicUrl } = ctx;
  if (publicUrl === undefined) throw new Error('Attachment outputs need the executor’s publicUrl');
  const creatorIds = [...new Set(rows.map((r) => r.creatorId))];
  const userRows = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, creatorIds));
  const names = new Map(userRows.map((u) => [u.id, u.name]));
  return rows.map((row) => {
    const name = names.get(row.creatorId);
    // Users are never purged (permissions §6, E8): a miss is a bug, never input.
    if (name === undefined) throw new Error(`Attachment ${row.id} names a missing user`);
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      url: row.url,
      fileName: row.fileName,
      mimeType: row.mimeType,
      size: row.size,
      imageWidth: row.imageWidth,
      imageHeight: row.imageHeight,
      downloadUrl: fileUrl(publicUrl, row.fileId),
      previewUrl: fileUrl(publicUrl, row.previewFileId),
      createdAt: row.createdAt.toISOString(),
      creator: { id: row.creatorId, name },
    };
  });
}

/** The attachments of each issue, oldest first (§6.2: `IssueOutput.attachments`). */
export async function attachmentsByIssue(
  ctx: Pick<HandlerContext, 'tx' | 'publicUrl'>,
  issueIds: readonly string[],
): Promise<Map<string, AttachmentSummary[]>> {
  const byIssue = new Map<string, AttachmentSummary[]>();
  if (issueIds.length === 0) return byIssue;
  const rows = await ctx.tx
    .select()
    .from(attachments)
    .where(inArray(attachments.issueId, [...issueIds]))
    // UUIDv7 ids sort by creation: the order the issue page shows (§3.4).
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  const summaries = await attachmentSummaries(ctx, rows);
  rows.forEach((row, i) => {
    const summary = summaries[i];
    if (summary === undefined) return;
    const list = byIssue.get(row.issueId) ?? [];
    list.push(summary);
    byIssue.set(row.issueId, list);
  });
  return byIssue;
}

/** One row's full output: its summary, its issue and `updatedAt`. */
export async function attachmentOutput(
  ctx: Pick<HandlerContext, 'tx' | 'publicUrl'>,
  row: AttachmentRow,
): Promise<AttachmentOutput> {
  const [summary] = await attachmentSummaries(ctx, [row]);
  if (summary === undefined) throw new Error(`No output for attachment ${row.id}`);
  const [issue] = await ctx.tx
    .select({ teamId: issues.teamId, number: issues.number })
    .from(issues)
    .where(eq(issues.id, row.issueId));
  if (issue === undefined) throw new Error(`Attachment ${row.id} names a missing issue`);
  return {
    ...summary,
    issue: { id: row.issueId, identifier: await identifierOf(ctx.tx, issue) },
    updatedAt: row.updatedAt.toISOString(),
  };
}
