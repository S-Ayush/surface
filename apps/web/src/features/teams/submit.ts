// Running a team mutation from a form or a button (SPEC-002 §3.3). The optimistic change shows at
// once. Online, the caller waits for the server's answer, so a refusal shows on the field it
// concerns (SPEC-001 E11); offline, or once the connection drops while waiting, the change stays
// queued and the caller moves on, and a later refusal is the shell's toast (SPEC-002 §3.5). Nothing
// here talks to the network itself.
import type { AnyOperation, InputOf } from '@surface/operations';
import type { MutationOutcome } from '@surface/sync-client';
import { toast } from '@surface/ui';
import { when } from 'mobx';

/** The part of the store a form needs. `connection` is observable (MobX). */
export type MutationStore = {
  readonly connection: string;
  dispatch<Op extends AnyOperation>(op: Op, input: InputOf<Op>): Promise<MutationOutcome>;
};

export type Submission =
  | { readonly kind: 'confirmed' }
  /** Not online, or the connection dropped while waiting: queued, sent when it returns. */
  | { readonly kind: 'queued' }
  /** The server refused it. The shell toasts it too (SPEC-002 §3.5). */
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  /** The store didn't take it (invalid input, not ready, queue lost): nothing was queued. */
  | { readonly kind: 'failed'; readonly message: string };

export async function submitMutation<Op extends AnyOperation>(
  store: MutationStore,
  op: Op,
  input: InputOf<Op>,
): Promise<Submission> {
  let outcome: Promise<MutationOutcome>;
  try {
    outcome = store.dispatch(op, input);
  } catch (error) {
    return {
      kind: 'failed',
      message:
        error instanceof Error ? error.message : 'That change could not be saved. Try again.',
    };
  }
  // A refusal after we stop waiting is the shell's toast; keep the promise from going unhandled.
  outcome.catch(() => undefined);
  if (store.connection !== 'online') return { kind: 'queued' };
  const dropped = when(() => store.connection !== 'online');
  try {
    const result = await Promise.race([outcome, dropped.then(() => null)]);
    if (result === null) return { kind: 'queued' };
    return result.status === 'confirmed'
      ? { kind: 'confirmed' }
      : { kind: 'rejected', code: result.error.code, message: result.error.message };
  } finally {
    dropped.cancel();
  }
}

/**
 * For buttons with no form to show a problem in: a change the store didn't take gets a toast. A
 * server refusal already has the shell's.
 */
export function toastIfFailed(result: Submission): void {
  if (result.kind === 'failed') toast({ tone: 'danger', message: result.message });
}
