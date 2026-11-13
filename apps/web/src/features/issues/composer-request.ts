// What the next `issue:create` opens the composer with (SPEC-012 §3.1, §3.2). A command takes no
// arguments, so an entry point that has more to say than "open" (a group's `+`, a draft on the
// Drafts page, **Restore in composer**) leaves a request here and then runs the command. Like
// `labels/add-intent.ts`: one request at a time, taken by the composer when the command runs.
import type { AddTarget } from './list-model.js';

export type ComposerRequest =
  /** A group header's `+`: the group's status (and the user, on Assigned). */
  | { readonly kind: 'group'; readonly add: AddTarget }
  /** The Drafts page: this team's draft. `teamId` the user can no longer see opens in the default team (E7). */
  | { readonly kind: 'draft'; readonly teamId: string }
  /** **Restore in composer**: the rejected `issue.create` input. */
  | { readonly kind: 'rejected'; readonly input: unknown };

let pending: ComposerRequest | undefined;

/**
 * Runs `issue:create` with `request`. The handler takes it synchronously; a request it didn't take
 * (the command unavailable: the composer is already open, E6) is dropped, so a later `C` never
 * opens with a stale one. Returns whether the command ran.
 */
export function openComposerWith(
  request: ComposerRequest,
  run: (id: 'issue:create') => boolean,
): boolean {
  pending = request;
  try {
    return run('issue:create');
  } finally {
    pending = undefined;
  }
}

/** The request the composer opens with, taken once; undefined for a plain `C`. */
export function takeComposerRequest(): ComposerRequest | undefined {
  const request = pending;
  pending = undefined;
  return request;
}
