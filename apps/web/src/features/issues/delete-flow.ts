// Deleting an issue and taking it back (SPEC-012 §3.11, SPEC-015 §3.1; PLAN-012 S6). Pure of
// React: `askDelete` leaves a request the dialog host shows, `deleteIssue` runs the operation, and
// `restoreLastDeleted` is `Mod+Z`. The last-delete slot is memory only (one issue, this session).
import { issueDelete } from '@surface/operations';
import { lifecycleEvents } from '../archive/lifecycle-events.js';
import { restoreIssue, type RestoreDeps } from '../archive/restore-flow.js';
import { submitMutation, toastIfFailed, type MutationStore } from '../teams/submit.js';
import { announce } from './announcer.js';

export interface DeleteRequest {
  readonly issueId: string;
  /** `ENG-42`: a pending issue has none and is never offered Delete. */
  readonly identifier: string;
  readonly title: string;
  /** Called once the dialog has closed, confirmed or not: a list moves focus back to its row. */
  readonly onClosed?: () => void;
}

/** One dialog at a time, like `PickerRequests`. */
export class DeleteRequests {
  #current: DeleteRequest | undefined;
  readonly #listeners = new Set<() => void>();

  ask(request: DeleteRequest): void {
    this.#current = request;
    this.#emit();
  }

  /** Closes the dialog and tells the request. */
  close(): void {
    const request = this.#current;
    if (request === undefined) return;
    this.#current = undefined;
    this.#emit();
    request.onClosed?.();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  snapshot = (): DeleteRequest | undefined => this.#current;

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

export const deleteRequests = new DeleteRequests();

export const askDelete = (request: DeleteRequest): void => {
  deleteRequests.ask(request);
};

/** The issue the user deleted last in this session (§3.11 item 3). */
export interface DeletedIssue {
  readonly id: string;
  readonly identifier: string;
}

/** One slot, memory only: a reload, the next delete or a restore replaces or empties it. */
export class LastDelete {
  #slot: DeletedIssue | undefined;

  get(): DeletedIssue | undefined {
    return this.#slot;
  }

  set(issue: DeletedIssue): void {
    this.#slot = issue;
  }

  /** Empties the slot and returns what it held. */
  take(): DeletedIssue | undefined {
    const slot = this.#slot;
    this.#slot = undefined;
    return slot;
  }

  /** Empties the slot only if it still holds `id` (a later delete keeps its own). */
  clearIf(id: string): void {
    if (this.#slot?.id === id) this.#slot = undefined;
  }
}

export const lastDelete = new LastDelete();

/**
 * The confirmed delete. The optimistic change removes the issue at once and a refusal returns it
 * (SPEC-015 E25); there is no Undo toast (D8), and the live region says what happened.
 */
export async function deleteIssue(
  store: MutationStore,
  issue: { readonly issueId: string; readonly identifier: string },
  slot: LastDelete = lastDelete,
): Promise<void> {
  slot.set({ id: issue.issueId, identifier: issue.identifier });
  announce(`${issue.identifier} deleted`);
  const result = await submitMutation(store, issueDelete, { issue: issue.issueId });
  // A refusal is the shell's toast with the server's message; Mod+Z has nothing to restore.
  if (result.kind === 'rejected' || result.kind === 'failed') {
    slot.clearIf(issue.issueId);
    lifecycleEvents.emit({ kind: 'refused', op: 'delete', issueId: issue.issueId });
  }
  // The archive page refreshes on the user's own confirmations (SPEC-015 §3.3 item 6).
  if (result.kind === 'confirmed') {
    lifecycleEvents.emit({ kind: 'confirmed', op: 'delete', issueId: issue.issueId });
  }
  toastIfFailed(result);
}

/**
 * `Mod+Z` outside text (§3.11 item 3): restores the last deleted issue through PLAN-015 S4's
 * restore flow ("Restoring ENG-42…" until the mutation is confirmed, then "Restored ENG-42" with
 * **Open**; never waiting for a packet, since the connection may not subscribe to the issue's
 * team). Does nothing with nothing remembered. The slot empties at once, so a second press never
 * restores twice, and a refusal (someone restored or purged it first, E24) leaves it empty.
 */
export async function restoreLastDeleted(
  store: MutationStore,
  slot: LastDelete = lastDelete,
  deps: RestoreDeps = {},
): Promise<void> {
  const deleted = slot.take();
  if (deleted === undefined) return;
  await restoreIssue(store, deleted, deps);
}
