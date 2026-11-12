// "Add status…" from the command menu (SPEC-010 §7.3): the menu picks the category in a sub-page,
// goes to the workflow page, and the page opens its inline add form in that category and focuses
// the name field. The two meet here, because the page may not be mounted yet when the command
// runs. One pending request at a time; the page takes it. A request that its page doesn't take
// within a few seconds expires, and the page clears it when it unmounts, so it can't open a form
// long after the command ran.
import type { EditableCategory } from './model.js';

export type AddStatusRequest = { readonly teamKey: string; readonly category: EditableCategory };

/** How long the page has to take a request: long enough to navigate and load the replica. */
export const ADD_STATUS_TTL_MS = 5_000;

let pending: { readonly request: AddStatusRequest; readonly at: number } | undefined;
const listeners = new Set<() => void>();

export function requestAddStatus(request: AddStatusRequest, now: number = Date.now()): void {
  pending = { request, at: now };
  for (const listener of [...listeners]) listener();
}

/** Takes the pending request if it is for this team and still fresh; others stay for their page. */
export function takeAddStatus(
  teamKey: string,
  now: number = Date.now(),
): AddStatusRequest | undefined {
  if (pending === undefined) return undefined;
  if (now - pending.at > ADD_STATUS_TTL_MS) {
    pending = undefined;
    return undefined;
  }
  if (pending.request.teamKey !== teamKey.toUpperCase()) return undefined;
  const { request } = pending;
  pending = undefined;
  return request;
}

/**
 * Drops a request nobody took (the page unmounted). With a team key, only that team's: leaving
 * one team's page for another's must not drop the request that caused the move.
 */
export function clearAddStatus(teamKey?: string): void {
  if (teamKey === undefined || pending?.request.teamKey === teamKey.toUpperCase()) {
    pending = undefined;
  }
}

/** Calls `listener` when a request arrives; returns the way to stop. */
export function subscribeAddStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
