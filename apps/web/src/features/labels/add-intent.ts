// "Create label…" from the command menu (SPEC-010 §7.3): the menu picks the scope, goes to that
// labels page, and the page opens its inline "New label" row and focuses the name field. The two
// meet here, because the page may not be mounted yet when the command runs. One pending request
// at a time; the page takes it. A request its page doesn't take within a few seconds expires, and
// the page clears it when it unmounts, like `statuses/add-intent.ts`.

/** The page a request is for: a team's key (any case), or the workspace's page. */
export type CreateLabelRequest = { readonly scope: string };

export const WORKSPACE_SCOPE = 'workspace';

/** How long the page has to take a request: long enough to navigate and load the replica. */
export const CREATE_LABEL_TTL_MS = 5_000;

let pending: { readonly request: CreateLabelRequest; readonly at: number } | undefined;
const listeners = new Set<() => void>();

const normal = (scope: string) => (scope === WORKSPACE_SCOPE ? scope : scope.toUpperCase());

export function requestCreateLabel(request: CreateLabelRequest, now: number = Date.now()): void {
  pending = { request: { scope: normal(request.scope) }, at: now };
  for (const listener of [...listeners]) listener();
}

/** Takes the pending request if it is for this page and still fresh; others stay for their page. */
export function takeCreateLabel(scope: string, now: number = Date.now()): boolean {
  if (pending === undefined) return false;
  if (now - pending.at > CREATE_LABEL_TTL_MS) {
    pending = undefined;
    return false;
  }
  if (pending.request.scope !== normal(scope)) return false;
  pending = undefined;
  return true;
}

/** Drops a request nobody took (the page unmounted), for this page only when `scope` is given. */
export function clearCreateLabel(scope?: string): void {
  if (scope === undefined || pending?.request.scope === normal(scope)) pending = undefined;
}

/** Calls `listener` when a request arrives; returns the way to stop. */
export function subscribeCreateLabel(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
