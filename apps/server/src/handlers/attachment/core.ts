/**
 * The attachment rules (SPEC-014 §4.1, §6.2–§6.4; PLAN-014 S4a), over an `AttachmentAccess` so
 * the unit tests run them on fakes and the handlers on the operation's transaction.
 *
 * Lock order (SPEC-011 §4.8, SPEC-014 §4.5): the issue row first (`lockIssueForWrite`, `edit` for
 * every operation but the preview job's `setPreview`, which is a `cascade`), then the attachment
 * row, then its `files` row. Claiming and detaching a file are plain `UPDATE`s of the row: they
 * neither insert nor delete a row, so they take no key lock (PLAN-014 S3 "For S4a").
 *
 * History (§6.3): created and removed attachments write an entry on the issue with their titles,
 * folded into `created` like any field; renames and previews write none. Events
 * `attachment.created` and `attachment.deleted` go to the outbox.
 */
import {
  attachmentTitle,
  ATTACHMENT_MESSAGES,
  defaultLinkTitle,
  issueLockModeOf,
  MAX_ATTACHMENTS_PER_ISSUE,
  parseAttachmentUrl,
  type AttachmentChange,
  type AttachmentKind,
  type IssueLockMode,
} from '@surface/domain';
import type { DomainEvent } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { refNotFound } from '../../executor/refs/sources.js';
import { isImageType } from '../../files/image.js';
import { writeUpdatedHistory, type HistoryWriteContext } from '../../issues/history.js';
import type { LockedIssue } from '../../issues/lifecycle.js';
import type { ModelRow } from '../../sync/models.js';
import type { Repo } from '../../sync/repo.js';

export type AttachmentRow = ModelRow<'Attachment'>;

/** The file row's facts an attachment copies (D15). */
export interface ClaimedFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
}

/** Reads, locks and the two `files` updates, in the operation's transaction. */
export interface AttachmentAccess {
  /** `lockIssueForWrite` in `mode` (the lifecycle rule table's, `issueLockModeOf`). */
  lockIssue(issueId: string, mode: IssueLockMode): Promise<LockedIssue>;
  /** How many attachments the issue has, read under its lock (D20). */
  countOnIssue(issueId: string): Promise<number>;
  /** The attachment `FOR UPDATE`, after the issue lock; undefined when it is gone. */
  lockAttachment(id: string): Promise<AttachmentRow | undefined>;
  /**
   * `createFile`'s claim, one conditional `UPDATE … RETURNING` (§6.2): the file becomes the
   * issue's, with `detached_at` cleared, if it is an `attachment` file that is either `userId`'s
   * own unclaimed upload or a detached file of this same issue (the undo, §3.5). Undefined when
   * it matched nothing: gone (clean-up deleted it), someone else's, another purpose, attached.
   */
  claimFile(fileId: string, issueId: string, userId: string): Promise<ClaimedFile | undefined>;
  /** `attachment.delete`: the file is detached at `at` (readable by nobody, §4.2). */
  detachFile(fileId: string, at: Date): Promise<void>;
  /** Whether `fileId` is a preview of `sourceId` (`setPreview`'s input check). */
  isPreviewOf(fileId: string, sourceId: string): Promise<boolean>;
  /** Queues the `files-preview` job for `fileId` in this transaction (§4.4, `singletonKey`). */
  enqueuePreview(fileId: string): Promise<void>;
}

export interface AttachmentWriteContext {
  readonly access: AttachmentAccess;
  readonly repo: Repo;
  readonly history: HistoryWriteContext;
  readonly emit: (event: DomainEvent) => void;
  readonly now: Date;
}

/** Who creates an attachment: the user, or for `api` and `mcp` the key's owner. */
export function creatorIdOf(actor: { readonly kind: string; readonly userId?: string }): string {
  if (actor.kind === 'system' || actor.userId === undefined) {
    throw new SurfaceError(
      'FORBIDDEN',
      'Only a signed-in user or an API key can attach to issues.',
    );
  }
  return actor.userId;
}

function invalid(field: string, message: string): SurfaceError {
  return new SurfaceError('INVALID_INPUT', message, { issues: [{ path: [field], message }] });
}

/** The issue lock in the operation's mode, then the 100 limit under it (D20). */
async function lockForNew(ctx: AttachmentWriteContext, op: string, issueId: string) {
  const issue = await ctx.access.lockIssue(issueId, issueLockModeOf(op));
  if ((await ctx.access.countOnIssue(issue.id)) >= MAX_ATTACHMENTS_PER_ISSUE) {
    throw invalid('issue', ATTACHMENT_MESSAGES.limit);
  }
  return issue;
}

/** The history entry and the event of an added or removed attachment (§6.3). */
async function record(
  ctx: AttachmentWriteContext,
  issue: LockedIssue,
  row: AttachmentRow,
  change: 'added' | 'removed',
): Promise<void> {
  const entry = { id: row.id, kind: row.kind, title: row.title };
  const attachments: AttachmentChange =
    change === 'added' ? { added: [entry], removed: [] } : { added: [], removed: [entry] };
  // Nothing else of the issue changed: an empty change set with the attachment change.
  await writeUpdatedHistory(ctx.history, issue, {}, { attachments });
  ctx.emit({
    type: change === 'added' ? 'attachment.created' : 'attachment.deleted',
    subject: { type: 'attachment', id: row.id },
    data: { issueId: issue.id, kind: row.kind },
  });
}

export interface CreateFileInput {
  readonly id: string;
  readonly issueId: string;
  /** The `file` input as given, for a refusal worded like an unknown id. */
  readonly fileRef: string;
  readonly fileId: string;
  readonly title: string | undefined;
  readonly creatorId: string;
}

/**
 * `attachment.createFile` (§6.2, AC-7): claims the file (or clears `detached_at` for an undo),
 * copies its name, type, size and dimensions onto the row, and queues the preview of a raster
 * image in the same transaction (§4.4; the job reuses the preview an undone removal left). Any
 * file it can't take is `NOT_FOUND` on `file`, worded exactly like an unknown id (§6.4), so a
 * refusal never tells files apart.
 */
export async function createFileAttachment(
  ctx: AttachmentWriteContext,
  input: CreateFileInput,
): Promise<AttachmentRow> {
  const issue = await lockForNew(ctx, 'attachment.createFile', input.issueId);
  const file = await ctx.access.claimFile(input.fileId, issue.id, input.creatorId);
  if (file === undefined) throw refNotFound('FileRef', input.fileRef, ['file']);
  const row = await ctx.repo.insert('Attachment', {
    id: input.id,
    issueId: issue.id,
    // The repo stores the issue row's team whatever is passed (SPEC-011 §5.1).
    teamId: issue.teamId,
    kind: 'file',
    title: attachmentTitle(input.title, file.name),
    url: null,
    fileId: file.id,
    fileName: file.name,
    mimeType: file.mimeType,
    size: file.size,
    imageWidth: file.width,
    imageHeight: file.height,
    previewFileId: null,
    creatorId: input.creatorId,
  });
  await record(ctx, issue, row, 'added');
  if (isImageType(file.mimeType)) await ctx.access.enqueuePreview(file.id);
  return row;
}

export interface CreateLinkInput {
  readonly id: string;
  readonly issueId: string;
  readonly url: string;
  readonly title: string | undefined;
  readonly creatorId: string;
}

/** `attachment.createLink` (§6.2): the URL as parsed, the title typed or defaulted (D10). */
export async function createLinkAttachment(
  ctx: AttachmentWriteContext,
  input: CreateLinkInput,
): Promise<AttachmentRow> {
  // The input schema checked it; parsing again gives the stored form (`href`).
  const parsed = parseAttachmentUrl(input.url);
  if (!parsed.ok) throw invalid('url', parsed.problem);
  const issue = await lockForNew(ctx, 'attachment.createLink', input.issueId);
  const row = await ctx.repo.insert('Attachment', {
    id: input.id,
    issueId: issue.id,
    teamId: issue.teamId,
    kind: 'link' satisfies AttachmentKind,
    title: attachmentTitle(input.title, defaultLinkTitle(parsed.url)),
    url: parsed.url,
    fileId: null,
    fileName: null,
    mimeType: null,
    size: null,
    imageWidth: null,
    imageHeight: null,
    previewFileId: null,
    creatorId: input.creatorId,
  });
  await record(ctx, issue, row, 'added');
  return row;
}

/** A resolved `AttachmentRef`: the attachment and its issue. */
export interface AttachmentTarget {
  readonly attachmentId: string;
  readonly issueId: string;
  /** The `attachment` input as given, for a refusal worded like an unknown id. */
  readonly ref: string;
}

/** The issue in `op`'s mode, then the attachment; gone meanwhile is `NOT_FOUND` like unknown. */
async function lockTarget(
  ctx: AttachmentWriteContext,
  op: string,
  target: AttachmentTarget,
): Promise<{ readonly issue: LockedIssue; readonly row: AttachmentRow }> {
  const issue = await ctx.access.lockIssue(target.issueId, issueLockModeOf(op));
  const row = await ctx.access.lockAttachment(target.attachmentId);
  if (row === undefined || row.issueId !== issue.id) {
    throw refNotFound('AttachmentRef', target.ref, ['attachment']);
  }
  return { issue, row };
}

/** `attachment.update` (§6.2): a new title; no history (§6.3), nothing written when unchanged. */
export async function renameAttachment(
  ctx: AttachmentWriteContext,
  target: AttachmentTarget,
  title: string,
): Promise<AttachmentRow> {
  const { row } = await lockTarget(ctx, 'attachment.update', target);
  const next = attachmentTitle(title, row.title);
  if (next === row.title) return row;
  return ctx.repo.update('Attachment', row.id, { title: next });
}

/**
 * `attachment.delete` (§6.2, AC-9): deletes the row (a `D`) and detaches its file, which stays 24
 * hours for an undo and is then deleted by `files-cleanup` (D5).
 */
export async function deleteAttachment(
  ctx: AttachmentWriteContext,
  target: AttachmentTarget,
): Promise<AttachmentRow> {
  const { issue, row } = await lockTarget(ctx, 'attachment.delete', target);
  await ctx.repo.purge('Attachment', row.id);
  if (row.fileId !== null) await ctx.access.detachFile(row.fileId, ctx.now);
  await record(ctx, issue, row, 'removed');
  return row;
}

/**
 * `attachment.setPreview` (§4.4): the preview job, as the system, names the preview it made. A
 * `cascade` lock: not refused on an archived or deleted issue (§3.7). No history, no event. The
 * file must be a preview of the attachment's own file.
 */
export async function setAttachmentPreview(
  ctx: AttachmentWriteContext,
  target: AttachmentTarget,
  previewFileId: string,
): Promise<AttachmentRow> {
  const { row } = await lockTarget(ctx, 'attachment.setPreview', target);
  if (row.fileId === null || !(await ctx.access.isPreviewOf(previewFileId, row.fileId))) {
    throw invalid('previewFile', `File ${previewFileId} is not a preview of this attachment.`);
  }
  if (row.previewFileId === previewFileId) return row;
  return ctx.repo.update('Attachment', row.id, { previewFileId });
}
