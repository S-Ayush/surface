// Restoring an issue (SPEC-015 §3.1 item 4, §3.3 item 7, E14, E24; PLAN-015 S4). One flow behind
// `#`, the archive row menu, the issue page's ⋯ menu, "Restore issue" in `Mod+K` and PLAN-012 S6's
// `Mod+Z`. Pure of React.
//
// The toast says "Restoring ENG-42…" until the mutation is confirmed, then "Restored ENG-42" with
// **Open**. It never waits for a packet: the replica holds no archived or deleted issue, so there is
// nothing to patch (§6.2), and a connection that doesn't subscribe to the issue's team may never
// get one. Offline it queues and says so; the toast still finishes on the confirmation (E14).
// The archive list drops the row at once (`restoring`) and refreshes on the confirmation.
import { issueRestore } from '@surface/operations';
import type { MutationOutcome } from '@surface/sync-client';
import { toast as showToast, type ToastOptions } from '@surface/ui';
import type { MutationStore } from '../teams/submit.js';
import { announce } from '../issues/announcer.js';
import { lifecycleEvents, type LifecycleEvents } from './lifecycle-events.js';

export interface RestoreTarget {
  readonly id: string;
  /** `ENG-42`. */
  readonly identifier: string;
}

type Toast = ((options: ToastOptions) => unknown) & { dismiss(id: string): void };

export interface RestoreDeps {
  /** **Open** on the "Restored" toast; no action without it. */
  readonly open?: (issue: RestoreTarget) => void;
  readonly events?: LifecycleEvents;
  readonly toast?: Toast;
}

/** One toast per issue, so restoring two at once never mixes them up. */
export const restoreToastId = (issueId: string) => `issue-restore:${issueId}`;

export const restoringMessage = (identifier: string) => `Restoring ${identifier}…`;
export const restoredMessage = (identifier: string) => `Restored ${identifier}`;
export const restoreQueuedMessage = (identifier: string) =>
  `${identifier} will be restored when you're back online.`;

export type RestoreResult = 'confirmed' | 'queued' | 'refused';

/**
 * Sends `issue.restore` and follows it to the server's answer. A refusal (purged meanwhile, past
 * its purgeAfter: E4, E24) is the shell's toast with the server's message; this one stops saying
 * "Restoring". Offline it resolves at once with `queued`.
 */
export function restoreIssue(
  store: MutationStore,
  issue: RestoreTarget,
  deps: RestoreDeps = {},
): Promise<RestoreResult> {
  const events = deps.events ?? lifecycleEvents;
  const toast = deps.toast ?? showToast;
  const id = restoreToastId(issue.id);
  let outcome: Promise<MutationOutcome>;
  try {
    outcome = store.dispatch(issueRestore, { issue: issue.id });
  } catch (error) {
    // The store didn't take it (not ready, queue lost): nothing was queued.
    toast({
      tone: 'danger',
      message:
        error instanceof Error && error.message !== ''
          ? error.message
          : `Couldn't restore ${issue.identifier}. Try again.`,
    });
    events.emit({ kind: 'refused', op: 'restore', issueId: issue.id });
    return Promise.resolve('refused');
  }
  const online = store.connection === 'online';
  events.emit({ kind: 'restoring', issueId: issue.id });
  toast({
    id,
    message: online ? restoringMessage(issue.identifier) : restoreQueuedMessage(issue.identifier),
    duration: Infinity,
  });
  const finished = outcome.then(
    (result): RestoreResult => {
      if (result.status !== 'confirmed') {
        toast.dismiss(id);
        events.emit({ kind: 'refused', op: 'restore', issueId: issue.id });
        return 'refused';
      }
      const message = restoredMessage(issue.identifier);
      const open = deps.open;
      toast({
        id,
        message,
        ...(open === undefined
          ? {}
          : {
              action: {
                label: 'Open',
                onAction: () => {
                  open(issue);
                },
              },
            }),
      });
      announce(message);
      events.emit({ kind: 'confirmed', op: 'restore', issueId: issue.id });
      return 'confirmed';
    },
    (): RestoreResult => {
      toast({ id, tone: 'danger', message: `Couldn't restore ${issue.identifier}. Try again.` });
      events.emit({ kind: 'refused', op: 'restore', issueId: issue.id });
      return 'refused';
    },
  );
  // Offline the caller isn't kept waiting; the toast still finishes on the confirmation (E14).
  return online ? finished : Promise.resolve('queued');
}
