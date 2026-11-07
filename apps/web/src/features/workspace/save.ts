// Saving Settings → Workspace's name (SPEC-001 §3.6, PLAN-001 S7), apart from React so it tests
// without a browser. `workspace.update` predicts nothing, so the form waits for the server: a
// confirmed save drops the edit (the field then shows the synced name), a refusal shows its
// message, and offline the edit stays with a note until the queued change is sent.
import { workspaceUpdate } from '@surface/operations';
import { submitMutation, type MutationStore } from '../teams/submit.js';

/** Why `name` can't be the workspace's name, in the operation's own words; undefined if it can. */
export function workspaceNameProblem(name: string): string | undefined {
  const parsed = workspaceUpdate.input.safeParse({ name });
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

export const QUEUED_NOTE = 'You’re offline. The new name is saved when you’re back online.';

export type WorkspaceSave =
  /** Nothing to send: unchanged, or invalid (the field shows why). */
  | { readonly kind: 'skipped' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'queued'; readonly note: string }
  | { readonly kind: 'error'; readonly message: string };

export async function saveWorkspaceName(
  store: MutationStore,
  name: string,
  saved: string,
): Promise<WorkspaceSave> {
  if (name.trim() === saved || workspaceNameProblem(name) !== undefined) return { kind: 'skipped' };
  const result = await submitMutation(store, workspaceUpdate, { name });
  switch (result.kind) {
    case 'confirmed':
      return { kind: 'saved' };
    case 'queued':
      return { kind: 'queued', note: QUEUED_NOTE };
    case 'rejected':
    case 'failed':
      return { kind: 'error', message: result.message };
  }
}
