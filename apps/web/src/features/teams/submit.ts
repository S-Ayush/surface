// Running a team mutation from a form or a button (SPEC-002 §3.3). The optimistic change shows at
// once. Online, the caller waits for the server's answer, so a refusal shows on the field it
// concerns (SPEC-001 E11); offline, or once the connection drops while waiting, the change stays
// queued and the caller moves on, and a later refusal is the shell's toast (SPEC-002 §3.5). A form
// that shows the refusal itself keeps that toast quiet while it waits (`showsRejection`), so a
// refusal is reported once (PLAN-001 S8 known issue). Nothing here talks to the network itself.
import type { AnyOperation, InputOf } from '@surface/operations';
import type { DispatchOptions, MutationOutcome, RejectionError } from '@surface/sync-client';
import { toast } from '@surface/ui';
import { when } from 'mobx';
import { useCallback, useEffect, useRef } from 'react';

/** The part of the store a form needs. `connection` is observable (MobX). */
export type MutationStore = {
  readonly connection: string;
  dispatch<Op extends AnyOperation>(
    op: Op,
    input: InputOf<Op>,
    options?: DispatchOptions,
  ): Promise<MutationOutcome>;
};

export type Submission =
  | { readonly kind: 'confirmed' }
  /** Not online, or the connection dropped while waiting: queued, sent when it returns. */
  | { readonly kind: 'queued' }
  /**
   * The server refused it. The shell toasts it too (SPEC-002 §3.5), unless the caller said it
   * shows it (`showsRejection`). `issues` name the fields at fault (sync-protocol v0.6).
   */
  | {
      readonly kind: 'rejected';
      readonly code: string;
      readonly message: string;
      readonly issues?: RejectionError['issues'];
    }
  /** The store didn't take it (invalid input, not ready, queue lost): nothing was queued. */
  | { readonly kind: 'failed'; readonly message: string };

export interface SubmitOptions {
  /**
   * The caller shows a refusal itself (inline, on its form) while this returns true, e.g. while
   * its dialog is open or its screen is mounted. The shell's toast then stays quiet, so the
   * user hears of it once. Once this stops waiting (offline, a dropped connection) or this
   * returns false, a later refusal is the shell's toast again.
   */
  readonly showsRejection?: () => boolean;
}

export async function submitMutation<Op extends AnyOperation>(
  store: MutationStore,
  op: Op,
  input: InputOf<Op>,
  options: SubmitOptions = {},
): Promise<Submission> {
  const { showsRejection } = options;
  // Whether a refusal will still reach the caller: true until we stop waiting for the answer.
  let waiting = true;
  const dispatchOptions: DispatchOptions = {
    reportRejection: () => !(waiting && showsRejection?.() === true),
  };
  let outcome: Promise<MutationOutcome>;
  try {
    outcome =
      showsRejection === undefined
        ? store.dispatch(op, input)
        : store.dispatch(op, input, dispatchOptions);
  } catch (error) {
    return {
      kind: 'failed',
      message:
        error instanceof Error ? error.message : 'That change could not be saved. Try again.',
    };
  }
  // A refusal after we stop waiting is the shell's toast; keep the promise from going unhandled.
  outcome.catch(() => undefined);
  if (store.connection !== 'online') {
    waiting = false;
    return { kind: 'queued' };
  }
  const dropped = when(() => store.connection !== 'online');
  try {
    const result = await Promise.race([outcome, dropped.then(() => null)]);
    if (result === null) {
      waiting = false;
      return { kind: 'queued' };
    }
    if (result.status === 'confirmed') return { kind: 'confirmed' };
    const { code, message, issues } = result.error;
    return { kind: 'rejected', code, message, ...(issues !== undefined ? { issues } : {}) };
  } finally {
    dropped.cancel();
  }
}

/**
 * For a form that shows a refusal itself: `showsRejection` for `submitMutation`, true while the
 * component is mounted (an unmounted form shows nothing, so the shell's toast must).
 */
export function useShowsRejection(): () => boolean {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => mounted.current, []);
}

/**
 * For buttons with no form to show a problem in: a change the store didn't take gets a toast. A
 * server refusal already has the shell's.
 */
export function toastIfFailed(result: Submission): void {
  if (result.kind === 'failed') toast({ tone: 'danger', message: result.message });
}
