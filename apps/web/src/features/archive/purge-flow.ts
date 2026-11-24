// Permanently deleting an issue (SPEC-015 §3.4, D14, E5, E9; PLAN-015 S4). Pure of React, like
// `delete-flow.ts`: `askPurge` leaves a request the dialog host shows, and `purgeIssue` runs
// `issue.purge` once **Permanently delete** is pressed. Admins only (the menu and the command
// hide it from Members; the server refuses them anyway). After the purge the open page asks the
// server again and shows the not-found state.
import { issuePurge } from '@surface/operations';
import { DeleteRequests, type DeleteRequest } from '../issues/delete-flow.js';
import { announce } from '../issues/announcer.js';
import { submitMutation, toastIfFailed, type MutationStore } from '../teams/submit.js';
import { lifecycleEvents, type LifecycleEvents } from './lifecycle-events.js';

export type PurgeRequest = DeleteRequest;

/** One dialog at a time, like the delete dialog's. */
export const purgeRequests = new DeleteRequests();

export const askPurge = (request: PurgeRequest): void => {
  purgeRequests.ask(request);
};

export const purgedMessage = (identifier: string) => `${identifier} was permanently deleted`;

/**
 * Sends `issue.purge` and waits for the answer. Nothing is predicted (§6.2): the replica holds no
 * deleted issue. A refusal is the shell's toast with the server's message (a Member, or an issue
 * restored meanwhile: "Delete ENG-42 first.").
 */
export async function purgeIssue(
  store: MutationStore,
  issue: { readonly issueId: string; readonly identifier: string },
  events: LifecycleEvents = lifecycleEvents,
): Promise<'confirmed' | 'queued' | 'refused'> {
  const result = await submitMutation(store, issuePurge, { issue: issue.issueId });
  toastIfFailed(result);
  switch (result.kind) {
    case 'confirmed':
      announce(purgedMessage(issue.identifier));
      events.emit({ kind: 'confirmed', op: 'purge', issueId: issue.issueId });
      return 'confirmed';
    case 'queued':
      return 'queued';
    case 'rejected':
    case 'failed':
      events.emit({ kind: 'refused', op: 'purge', issueId: issue.issueId });
      return 'refused';
  }
}
