/**
 * Claiming inline files (SPEC-014 §4.3, SPEC-011 §4.1, SPEC-013 §4.4; PLAN-014 S4b): saving a
 * document claims the uploaded files it references, in the saving transaction, after the handler
 * took the issue row lock. Every save of a document (`issue.create`, `issue.updateDescription`,
 * `comment.create`, `comment.update`) calls this one function.
 *
 * Each distinct `/files/<uuid>` reference (at most 50) is one of:
 * - the actor's own unclaimed `inline` upload: claimed by the issue, one conditional `UPDATE`;
 * - an `inline` file this issue already owns: kept;
 * - an attached file, or a preview of one, whose issue the actor sees (§4.2's issue branch, after
 *   key narrowing): copied into a new `inline` row of this issue on the same bytes, and the `src`
 *   rewritten to the copy (D1), so removing the attachment never breaks the document (E19);
 * - anything else (unknown, someone else's upload, detached, an issue the actor or its key can't
 *   see, an avatar or logo, the actor's own unclaimed `attachment` upload): the one refusal.
 *
 * Claims and copies go through `insertCopies` (`bytes.ts`) in one call: every row lock in id
 * order, then every key lock at once, so a save never deadlocks with clean-up or purge (§4.5). A
 * claim that matches no row there (clean-up deleted it, another save claimed it) or a source gone
 * meanwhile is the same refusal (E24), and the transaction rolls back the claims made.
 */
import { type Actor, type DocNodeJSON } from '@surface/domain';
import {
  DOC_MESSAGES,
  docFileIds,
  fileIdOfSrc,
  fileSrc,
  MAX_FILE_REFERENCES,
} from '@surface/editor/schema';
import { uuidv7 } from '../db/uuidv7.js';
import type { HandlerContext } from '../executor/context.js';
import { SurfaceError } from '../executor/errors.js';
import type { BlobStore } from './blob-store.js';
import { insertCopies, type FileLog, type FileTx, type InlineCopy } from './bytes.js';
import { documentFiles, fileReaderOf, type DocumentFile, type FileReader } from './store.js';

/** The issue the document belongs to, as its handler locked it. */
export interface ClaimTarget {
  readonly id: string;
  readonly teamId: string;
}

/** What a claim needs of the saving operation: its transaction, byte protocol and log. */
export interface ClaimStore {
  /** The referenced rows that exist, each with whether the reader may copy it (§4.2). */
  documentFiles(ids: readonly string[], reader: FileReader): Promise<DocumentFile[]>;
  readonly files: FileTx;
  readonly blobs: Pick<BlobStore, 'stat'>;
  readonly log: Pick<FileLog, 'error'>;
  /** A new file row's id. */
  newId(): string;
}

/** `ClaimStore` over a handler's context. */
export function claimStore(
  ctx: Pick<HandlerContext, 'tx' | 'files' | 'blobs' | 'log'>,
): ClaimStore {
  return {
    documentFiles: (ids, reader) => documentFiles(ctx.tx, ids, reader),
    files: ctx.files,
    blobs: ctx.blobs,
    log: ctx.log,
    newId: uuidv7,
  };
}

/** What happens to each referenced file; undefined when any one of them can't be used. */
export interface ClaimPlan {
  readonly claims: readonly string[];
  readonly kept: readonly string[];
  readonly copies: readonly DocumentFile[];
}

/**
 * §4.3's table, decided from the rows alone (no lock yet: `insertCopies` locks them and refuses a
 * row that changed meanwhile). Any unusable reference makes the whole document unusable.
 */
export function planClaims(
  ids: readonly string[],
  rows: ReadonlyMap<string, DocumentFile>,
  issueId: string,
  userId: string,
): ClaimPlan | undefined {
  const claims: string[] = [];
  const kept: string[] = [];
  const copies: DocumentFile[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (row === undefined) return undefined;
    if (row.purpose === 'inline' && row.issueId === issueId) kept.push(id);
    // The uploader, not visibility, decides (D25): a key limited to some teams claims its own.
    else if (row.purpose === 'inline' && row.issueId === null && row.uploaderId === userId) {
      claims.push(id);
    } else if (row.copyable) copies.push(row);
    else return undefined;
  }
  return { claims, kept, copies };
}

/** `doc` with every image and file `src` naming a key of `renamed` pointed at its value. */
export function rewriteFileSrcs(
  doc: DocNodeJSON,
  renamed: ReadonlyMap<string, string>,
): DocNodeJSON {
  const visit = (node: DocNodeJSON): DocNodeJSON => {
    let next = node;
    if ((node.type === 'image' || node.type === 'file') && node.attrs !== undefined) {
      const src = node.attrs['src'];
      const id = typeof src === 'string' ? fileIdOfSrc(src) : null;
      const to = id === null ? undefined : renamed.get(id);
      if (to !== undefined) next = { ...node, attrs: { ...node.attrs, src: fileSrc(to) } };
    }
    return next.content === undefined ? next : { ...next, content: next.content.map(visit) };
  };
  return visit(doc);
}

function refusal(field: string, message: string): SurfaceError {
  return new SurfaceError('INVALID_INPUT', message, { issues: [{ path: [field], message }] });
}

/**
 * Claims, keeps or copies every file `doc` references and resolves to the document to store
 * (rewritten when something was copied). `field` is the input field the document came from
 * (`body` for comments, `description` for issues): every unusable reference is the one identical
 * `INVALID_INPUT` on that field, never `NOT_FOUND` on the file, so nothing tells an unknown id
 * from a file the actor may not use (SPEC-013 E9, SPEC-014 §4.3, AC-8).
 */
export async function claimInlineFiles(
  store: ClaimStore,
  doc: DocNodeJSON,
  issue: ClaimTarget,
  actor: Actor,
  field = 'body',
): Promise<DocNodeJSON> {
  const ids = docFileIds(doc);
  if (ids.length === 0) return doc;
  // The schema check counts every reference (SPEC-013); this is the distinct-file backstop.
  if (ids.length > MAX_FILE_REFERENCES) throw refusal(field, DOC_MESSAGES.tooManyFiles);
  const unusable = () => refusal(field, DOC_MESSAGES.badFile);
  // The system actor saves no documents; it has no files either.
  const reader = fileReaderOf(actor);
  if (reader === undefined) throw unusable();

  const rows = new Map((await store.documentFiles(ids, reader)).map((row) => [row.id, row]));
  const plan = planClaims(ids, rows, issue.id, reader.userId);
  if (plan === undefined) throw unusable();
  if (plan.claims.length === 0 && plan.copies.length === 0) return doc;

  const copies: InlineCopy[] = plan.copies.map((source) => ({
    sourceId: source.id,
    file: {
      id: store.newId(),
      purpose: 'inline',
      name: source.name,
      mimeType: source.mimeType,
      size: source.size,
      // Who uploaded these bytes; nothing reads it for an owned file (D6).
      uploaderId: source.uploaderId,
      issueId: issue.id,
      width: source.width,
      height: source.height,
    },
  }));
  const claims = plan.claims.map((id) => ({ id, issueId: issue.id, uploaderId: reader.userId }));
  const result = await insertCopies(store.files, store.blobs, { claims, copies }, store.log);
  if (result.unusable.length > 0) throw unusable();
  if (copies.length === 0) return doc;
  return rewriteFileSrcs(doc, new Map(copies.map((copy) => [copy.sourceId, copy.file.id])));
}
