/**
 * The `files-preview` job (SPEC-014 §4.4, D7; ADR-0024; PLAN-014 S4b).
 *
 * - **Producer:** `attachment.createFile` queues one job per raster image it claims or re-attaches,
 *   on its own transaction's connection (`PreviewOutbox.enqueue`, `preview-queue.ts`), so the
 *   job exists only if the attachment commits. Every role queues (`web` too); only `all` and
 *   `worker` run the job.
 * - **Queue:** `stately`, keyed by the file id (`singletonKey`): at most one job queued and one
 *   running per file, so a re-attach while a job waits adds nothing, and one while a job runs
 *   waits for it and then finds the preview made.
 * - **Job:** finds the attachment that names the file. Gone, or with a preview already: nothing.
 *   A preview row of the file already there (a re-attach after a removal): named again. Else
 *   sharp makes an 800 px WebP from the file on disk (`previewMaker`, the process's shared decode
 *   limiter), the row is inserted with `insertPreview` (the source `FOR UPDATE`, its previews read
 *   again under that lock so an expired run and its retry never both insert, then the key lock
 *   and the rename, §4.5), and `attachment.setPreview` names it, as the system actor through the
 *   executor (CLAUDE.md rule 1). An image over 25 MP, or one that can't be decoded, gets none
 *   and logs `file preview failed`; that is not a job failure.
 */
import { Readable } from 'node:stream';
import { systemActor } from '@surface/domain';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import type { Pool } from '../db/pool.js';
import { uuidv7 } from '../db/uuidv7.js';
import type { Executor } from '../executor/execute.js';
import type { BlobStore } from '../files/blob-store.js';
import { insertPreview, type FileDb } from '../files/bytes.js';
import { isImageType, type PreviewImage } from '../files/image.js';
import { PREVIEW_QUEUE, PreviewPayload } from './preview-queue.js';

/** The attachment a job is for, and the file it shows. */
export interface PreviewTarget {
  readonly attachmentId: string;
  readonly previewFileId: string | null;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly name: string;
  readonly uploaderId: string;
  /** A preview row of the file made earlier (it outlives a removal, for the undo). */
  readonly existingPreviewId: string | null;
}

export interface PreviewDb {
  /** The attachment naming `fileId` and its file, or undefined when either is gone. */
  target(fileId: string): Promise<PreviewTarget | undefined>;
}

const PreviewTargetRow = z.object({
  attachmentId: z.string(),
  previewFileId: z.string().nullable(),
  storageKey: z.string(),
  mimeType: z.string(),
  name: z.string(),
  uploaderId: z.string(),
  existingPreviewId: z.string().nullable(),
});

export function pgPreviewDb(pool: Pool): PreviewDb {
  const db = drizzle({ client: pool, casing: 'snake_case' });
  return {
    async target(fileId) {
      // An attachment names an attached file (§4.9: a detached file has no attachment row).
      const { rows } = await db.execute(sql`
        SELECT a.id AS "attachmentId", a.preview_file_id AS "previewFileId",
               f.storage_key AS "storageKey", f.mime_type AS "mimeType", f.name,
               f.uploader_id AS "uploaderId",
               (SELECT p.id FROM files p WHERE p.preview_of = f.id ORDER BY p.id LIMIT 1)
                 AS "existingPreviewId"
          FROM attachments a
          JOIN files f ON f.id = a.file_id
         WHERE a.file_id = ${fileId} AND f.detached_at IS NULL`);
      const [row] = rows;
      return row === undefined ? undefined : PreviewTargetRow.parse(row);
    },
  };
}

/** What a run did, for tests and the debug log. */
export type PreviewOutcome =
  'made' | 'reused' | 'already' | 'gone' | 'not an image' | `skipped: ${string}`;

export interface PreviewLog {
  debug(object: object, message: string): void;
  warn(object: object, message: string): void;
}

export interface PreviewJobDeps {
  readonly db: PreviewDb;
  readonly files: FileDb;
  readonly blobs: BlobStore;
  readonly executor: Pick<Executor, 'execute'>;
  /** `previewMaker(log)`: one per process, on the shared decode limiter. */
  readonly make: (path: string) => Promise<PreviewImage>;
  readonly log: PreviewLog;
  readonly newId?: () => string;
}

/** A preview's name: the original's, with `.webp` for its extension (for `Content-Disposition`). */
export function previewName(name: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.webp`;
}

/** One run for `fileId` (see the file comment). Idempotent: a re-run after success does nothing. */
export async function makePreview(deps: PreviewJobDeps, fileId: string): Promise<PreviewOutcome> {
  const { db, files, blobs, log } = deps;
  const target = await db.target(fileId);
  if (target === undefined) return 'gone';
  if (target.previewFileId !== null) return 'already';
  if (target.existingPreviewId !== null) {
    return name(deps, target.attachmentId, target.existingPreviewId, 'reused');
  }
  if (!isImageType(target.mimeType)) return 'not an image';

  const path = blobs.localPath(target.storageKey);
  const image: PreviewImage =
    path === undefined ? { kind: 'skipped', reason: 'unreadable' } : await deps.make(path);
  if (image.kind === 'skipped') {
    log.warn({ fileId, reason: image.reason }, 'file preview failed');
    return `skipped: ${image.reason}`;
  }

  const temp = await blobs.putStream(Readable.from([image.bytes]));
  const previewId = (deps.newId ?? uuidv7)();
  let made:
    { readonly kind: 'inserted' | 'gone' } | { readonly kind: 'exists'; readonly id: string } = {
    kind: 'gone',
  };
  try {
    made = await files.transaction(async (tx) => {
      // A run whose job expired can overlap its retry (`stately` starts the retry then): the
      // source's row lock serialises them, and the later one names the earlier one's row
      // instead of adding a second. Source, then its previews, then the key: §4.5's order.
      const [source] = await tx.lockFiles([fileId], 'update');
      if (source === undefined) return { kind: 'gone' };
      const [existing] = await tx.lockPreviews([fileId]);
      if (existing !== undefined) return { kind: 'exists', id: existing.id };
      const inserted = await insertPreview(tx, blobs, temp, {
        id: previewId,
        purpose: 'preview',
        name: previewName(target.name),
        mimeType: 'image/webp',
        size: temp.size,
        // The column is NOT NULL and the system has no user: the source's uploader (§4.2).
        uploaderId: target.uploaderId,
        issueId: null,
        width: image.width,
        height: image.height,
        previewOf: fileId,
      });
      return { kind: inserted ? 'inserted' : 'gone' };
    });
  } finally {
    // Committed: the rename moved it, and discarding a moved file does nothing.
    if (made.kind !== 'inserted') await blobs.discard(temp.tempPath);
  }
  // The source was deleted meanwhile (E21): no preview.
  if (made.kind === 'gone') return 'gone';
  if (made.kind === 'exists') return name(deps, target.attachmentId, made.id, 'reused');
  return name(deps, target.attachmentId, previewId, 'made');
}

/**
 * `attachment.setPreview` as the system. The attachment removed meanwhile is `NOT_FOUND`: the
 * preview row stays with its source (an undo names it again, deleting the source deletes it).
 * Anything else fails the run, and pg-boss retries it (the retry reuses the row).
 */
async function name(
  deps: PreviewJobDeps,
  attachmentId: string,
  previewFileId: string,
  outcome: 'made' | 'reused',
): Promise<PreviewOutcome> {
  const result = await deps.executor.execute(
    'attachment.setPreview',
    { attachment: attachmentId, previewFile: previewFileId },
    systemActor(),
  );
  if (result.ok) return outcome;
  if (result.error.code === 'NOT_FOUND') return 'gone';
  throw new Error(`attachment.setPreview failed: ${result.error.code}`);
}

/** The pg-boss handler: one job per call, the payload checked first. */
export function previewJobHandler(deps: PreviewJobDeps) {
  return async (data: unknown): Promise<PreviewOutcome | undefined> => {
    const payload = PreviewPayload.safeParse(data);
    if (!payload.success) {
      deps.log.warn({ queue: PREVIEW_QUEUE.name }, 'file preview job has no file id');
      return undefined;
    }
    const outcome = await makePreview(deps, payload.data.fileId);
    deps.log.debug({ fileId: payload.data.fileId, outcome }, 'file preview job done');
    return outcome;
  };
}
