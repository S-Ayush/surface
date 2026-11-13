/**
 * The rules of `draft.save` and `draft.discard` (SPEC-012 §3.2, §4.3), over a small read interface
 * and the repo, so the unit tests run them on memory fakes (`test/draft-handlers.test.ts`).
 *
 * A draft belongs to the actor. Nothing here reads a team or an issue, or checks a permission on
 * one: the key's ids are stored as given (permissions.md §2, "Drafts").
 */
import { COMMENT_DRAFT_LIMIT, type DraftKind } from '@surface/domain/model';
import type { DraftKey } from '@surface/operations';
import type { CommentDraftData, ComposerDraftData } from '@surface/domain/model';
import { SurfaceError } from '../../executor/errors.js';
import type { Actor } from '@surface/domain';
import type { Repo } from '../../sync/repo.js';

/** A stored draft, as the handlers read and return it. */
export interface DraftRow {
  readonly id: string;
  readonly userId: string;
  readonly kind: DraftKind;
  readonly teamId: string | null;
  readonly issueId: string | null;
  readonly data: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The reads the rules need, in the operation's transaction. */
export interface DraftAccess {
  /**
   * Serialises the owner's draft writes (the users row, `FOR NO KEY UPDATE`): two saves of one key
   * at once would otherwise both insert, and the cap would count a stale set.
   */
  lockOwner(userId: string): Promise<void>;
  /** The owner's draft with this key, if any. */
  find(userId: string, key: DraftKey): Promise<DraftRow | undefined>;
  /** Ids of the owner's comment drafts beyond the newest `keep`, by `updatedAt` then id. */
  commentDraftsBeyond(userId: string, keep: number): Promise<string[]>;
}

export type DraftRepo = Pick<Repo, 'insert' | 'update' | 'purge'>;

/** The owner: the signed-in user. A draft has no meaning for an API key or the system actor. */
export function draftOwner(actor: Actor): string {
  if (actor.userId === undefined) {
    throw new SurfaceError('FORBIDDEN', 'Only a signed-in person has drafts.');
  }
  return actor.userId;
}

export interface SaveInput {
  readonly key: DraftKey;
  readonly data: ComposerDraftData | CommentDraftData;
  /** The id for a new draft: the client's, or one the handler made. */
  readonly newId: string;
}

/**
 * Upserts the owner's draft with this key (a retry makes no duplicate), then, for a comment draft,
 * deletes the oldest beyond the 50 the owner may keep.
 */
export async function saveDraft(
  access: DraftAccess,
  repo: DraftRepo,
  userId: string,
  { key, data, newId }: SaveInput,
): Promise<DraftRow> {
  await access.lockOwner(userId);
  const existing = await access.find(userId, key);
  const row: DraftRow =
    existing === undefined
      ? await repo.insert('Draft', {
          id: newId,
          userId,
          kind: key.kind,
          teamId: key.kind === 'composer' ? key.teamId : null,
          issueId: key.kind === 'comment' ? key.issueId : null,
          data,
        })
      : await repo.update('Draft', existing.id, { data });
  if (key.kind === 'comment') {
    for (const id of await access.commentDraftsBeyond(userId, COMMENT_DRAFT_LIMIT)) {
      await repo.purge('Draft', id);
    }
  }
  return row;
}

/** Deletes the owner's draft with this key. A missing one is not an error: there is nothing to do. */
export async function discardDraft(
  access: DraftAccess,
  repo: DraftRepo,
  userId: string,
  key: DraftKey,
): Promise<boolean> {
  await access.lockOwner(userId);
  const existing = await access.find(userId, key);
  if (existing === undefined) return false;
  await repo.purge('Draft', existing.id);
  return true;
}
