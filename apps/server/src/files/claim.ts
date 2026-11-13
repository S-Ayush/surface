/**
 * The inline-file claim seam (SPEC-014 §4.3, SPEC-011 §4.1): saving a document claims the uploaded
 * files it references, in the saving transaction. Every save of a document (`issue.create`,
 * `issue.updateDescription`, `comment.create`, `comment.update`) calls this one function.
 *
 * Stub body (PLAN-011 S6 / PLAN-013 S3, whichever lands first): it accepts a document with no
 * `/files/<uuid>` reference and refuses any reference with SPEC-014's message, so nothing
 * unclaimed is ever saved. PLAN-014 S4b replaces the body (claims, copies, rewritten `src`) and
 * changes no caller. It resolves to the document to store, which the real body may rewrite.
 */
import type { Actor, DocNodeJSON } from '@surface/domain';
import { docFileIds, DOC_MESSAGES } from '@surface/editor/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { SurfaceError } from '../executor/errors.js';

/** The issue the document belongs to, as its handler locked it. */
export interface ClaimTarget {
  readonly id: string;
  readonly teamId: string;
}

export function claimInlineFiles(
  _tx: NodePgDatabase,
  doc: DocNodeJSON,
  _issue: ClaimTarget,
  _actor: Actor,
): Promise<DocNodeJSON> {
  if (docFileIds(doc).length > 0) {
    return Promise.reject(new SurfaceError('INVALID_INPUT', DOC_MESSAGES.badFile));
  }
  return Promise.resolve(doc);
}
