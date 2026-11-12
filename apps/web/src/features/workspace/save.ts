// Saving Settings → Workspace's name (SPEC-001 §3.6, PLAN-001 S7), apart from React so it tests
// without a browser. `workspace.update` predicts nothing, so the form waits for the server: a
// confirmed save drops the edit (the field then shows the synced name), a refusal shows its
// message, and offline the edit stays with a note until the queued change is sent.
import { workspaceUpdate } from '@surface/operations';
import type { SettingsApi } from '../files/api.js';
import { submitMutation, type MutationStore, type SubmitOptions } from '../teams/submit.js';

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
  options?: SubmitOptions,
): Promise<WorkspaceSave> {
  if (name.trim() === saved || workspaceNameProblem(name) !== undefined) return { kind: 'skipped' };
  const result = await submitMutation(store, workspaceUpdate, { name }, options);
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

export type LogoChange = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Uploads `file` as the workspace logo (PLAN-001 S6) and sets it. `workspace.update` predicts
 * nothing (D6), so the new logo shows once the server confirms it.
 */
export async function changeLogo(
  api: Pick<SettingsApi, 'upload'>,
  store: MutationStore,
  file: Blob,
  options?: SubmitOptions,
): Promise<LogoChange> {
  const uploaded = await api.upload(file, 'logo');
  if (!uploaded.ok) return uploaded;
  return logoOutcome(await submitMutation(store, workspaceUpdate, { logo: uploaded.id }, options));
}

export async function removeLogo(
  store: MutationStore,
  options?: SubmitOptions,
): Promise<LogoChange> {
  return logoOutcome(await submitMutation(store, workspaceUpdate, { logo: null }, options));
}

function logoOutcome(result: Awaited<ReturnType<typeof submitMutation>>): LogoChange {
  return result.kind === 'rejected' || result.kind === 'failed'
    ? { ok: false, message: result.message }
    : { ok: true };
}
