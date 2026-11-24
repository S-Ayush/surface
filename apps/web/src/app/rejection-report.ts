// What the shell says about a rejected mutation that no open page shows itself (SPEC-002 §3.5):
// the store's `onRejected`, for a change sent after its page closed or after a reload. Pure of
// React and of the store, so the one toast per rejection is testable.
import type { Rejection } from '@surface/sync-client';
import type { ToastOptions } from '@surface/ui';
import {
  refusedDescription,
  refusedTextToast,
  type CopyTextDeps,
} from '../features/issues/locked-refusal.js';

export interface RejectionReportDeps {
  /** A comment's text back to its draft or **Copy text** (SPEC-013 §3.1 item 2, E21): true if so. */
  readonly queuedComment: (rejection: Rejection) => boolean;
  /** The message, naming a status this replica saw deleted when that is why (SPEC-010 E1). */
  readonly statusGone: (rejection: Rejection) => string;
  readonly toast: (options: ToastOptions) => unknown;
  readonly copyText: CopyTextDeps;
}

/** Shows one toast for `rejection`, or none when a comment's draft took its text back. */
export function reportRejection(rejection: Rejection, deps: RejectionReportDeps): void {
  if (deps.queuedComment(rejection)) return;
  // SPEC-015 E1 (PLAN-015 S4): a description save refused because the issue was deleted or
  // archived meanwhile offers **Copy text**.
  const description = refusedDescription(rejection.op, rejection.input);
  if (description !== undefined) {
    deps.toast(refusedTextToast(rejection.message, description, deps.copyText));
    return;
  }
  deps.toast({ tone: 'danger', message: deps.statusGone(rejection) });
}
