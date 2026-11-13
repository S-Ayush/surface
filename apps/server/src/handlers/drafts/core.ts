/**
 * The rules of `draft.save` and `draft.discard` (SPEC-012 §3.2, §4.3), over a small read interface
 * and the repo, so the unit tests run them on memory fakes (`test/draft-handlers.test.ts`).
 *
 * A draft belongs to the actor. Nothing here reads a team or an issue, or checks a permission on
 * one: the key's ids are stored as given (permissions.md §2, "Drafts").
 */
import { DRAFT_LIMITS, type DraftKind } from '@surface/domain/model';
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
  /** Ids of the owner's drafts of `kind` beyond the newest `keep`, by `updatedAt` then id. */
  draftsBeyond(userId: string, kind: DraftKind, keep: number): Promise<string[]>;
}

export type DraftRepo = Pick<Repo, 'insert' | 'update' | 'purge'>;

/**
 * The owner: the user the actor acts for. A session, an API key and an MCP client all act for a
 * user, so they own that user's drafts; only the system actor has no user, and is refused.
 */
export function draftOwner(actor: Actor): string {
  if (actor.userId === undefined) {
    throw new SurfaceError('FORBIDDEN', 'Drafts belong to a user. The system actor has none.');
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
 * Upserts the owner's draft with this key (a retry makes no duplicate), then deletes the oldest
 * drafts of its kind beyond the 50 the owner may keep.
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
  // 50 of each kind (SPEC-012 §3.2, §4.3): the oldest beyond go. The one just saved is the newest.
  for (const id of await access.draftsBeyond(userId, key.kind, DRAFT_LIMITS[key.kind])) {
    await repo.purge('Draft', id);
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
