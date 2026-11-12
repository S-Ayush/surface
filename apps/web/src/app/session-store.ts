// How a session's client store is tied to auth (used by ShellRoute). Kept apart from the
// component so the wiring is tested.
import { MUTATE_PATH } from '@surface/sync-protocol';
import type { AuthState } from './auth.js';
import { watchSession, type FetchLike } from './http.js';
import type { StoreSequence } from './stores.js';

/**
 * The sync client's fetch and 4001 handler for the session opened at `epoch`. Both only ask
 * who is signed in now (`AuthState.recheck`): after re-signing in elsewhere (SPEC-001 Q11) a
 * request with the old cookie gets 401 while the browser holds a live session.
 *
 * A mutate 401 the same session answers keeps this store: its queue parks, redials and resends
 * after its own backoff (SPEC-002 E14). Any other 401 (a bootstrap: a store whose first one fails
 * stops there) and a 4001 need a new store. The fetch adds no CSRF retry; the sync client does
 * its own (app/http.ts).
 */
export function sessionAuthHooks(auth: AuthState, epoch: number, fetchFn: FetchLike) {
  const unauthorized = (url: string) => {
    const mutate = new URL(url, 'http://surface.invalid').pathname === MUTATE_PATH;
    void auth.recheck(epoch, mutate ? 'unauthorized' : 'revoked');
  };
  const revoked = () => {
    void auth.recheck(epoch);
  };
  return { fetch: watchSession(fetchFn, unauthorized), onSessionRevoked: revoked };
}

/**
 * Starts the store once the previous session's store has closed (SPEC-002 E5); returns its
 * closer. A failed start is shown by the store's own status.
 */
export function runStore(
  stores: StoreSequence,
  store: { start(): Promise<unknown>; close(): Promise<void> },
): () => void {
  return stores.open(
    () => store.start().catch(() => undefined),
    () => store.close(),
  );
}
