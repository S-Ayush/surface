// The savers still holding an issue's description, per store, and what other features may ask of
// them. Kept apart from the editor so the comment box can reach a saver without importing it.
import type { SyncStore } from '@surface/sync-client';
import type { DescriptionSaver } from './description-save.js';

/**
 * The savers still holding an issue's description, per store (SPEC-012 D31): a page that opens the
 * issue again takes its saver back (and shows the text it holds), so two never race. Keyed by the
 * store, so a new session never meets one; a saver leaves once it stops.
 */
const SAVERS = new WeakMap<SyncStore, Map<string, DescriptionSaver>>();

export function saversOf(store: SyncStore): Map<string, DescriptionSaver> {
  let savers = SAVERS.get(store);
  if (savers === undefined) {
    savers = new Map();
    SAVERS.set(store, savers);
  }
  return savers;
}

/**
 * `Ctrl+M` / "Comment" (SPEC-012 §3.6): the description is saved first, so the text the user was
 * typing is on its way before focus moves to the comment box. `saveNow` does nothing when the
 * text is unchanged.
 */
export function commentFromDescription(
  store: SyncStore,
  issueId: string,
  focusComment: () => void,
): void {
  saversOf(store).get(issueId)?.saveNow();
  focusComment();
}
