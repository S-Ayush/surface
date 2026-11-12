// Settings → Account → Profile (SPEC-001 §3.5; PLAN-001 S6), apart from React so it tests
// without a browser. Saving runs `user.updateProfile` through the store: the change shows at
// once, here and (once confirmed) in every other client (AC-15). Online, the form waits for the
// server's answer, so a display name someone has (E5) shows on the field the server's issue names
// (sync-protocol v0.6), and the shell's toast stays quiet meanwhile (`showsRejection`).
import { userUpdateProfile } from '@surface/operations';
import type { SettingsApi } from '../files/api.js';
import { submitMutation, type MutationStore, type SubmitOptions } from '../teams/submit.js';

export type ProfileValues = {
  readonly name: string;
  readonly displayName: string;
  readonly timezone: string;
};
export type ProfileField = keyof ProfileValues;

export const PROFILE_QUEUED_NOTE = 'You’re offline. Your profile is saved when you’re back online.';

const FIELDS: readonly ProfileField[] = ['name', 'displayName', 'timezone'];

/** What changed, trimmed; only these are sent. */
export function profileChanges(
  saved: ProfileValues,
  edited: ProfileValues,
): Partial<ProfileValues> {
  const changes: { -readonly [K in ProfileField]?: string } = {};
  for (const field of FIELDS) {
    const value = edited[field].trim();
    if (value !== saved[field]) changes[field] = value;
  }
  return changes;
}

/** Each field's problem, in the operation's own words (the server checks the same rules). */
export function profileProblems(values: ProfileValues): Partial<Record<ProfileField, string>> {
  const problems: Partial<Record<ProfileField, string>> = {};
  for (const field of FIELDS) {
    // Checked as sent: trimmed.
    const parsed = userUpdateProfile.input.shape[field].safeParse(values[field].trim());
    const message = parsed.error?.issues[0]?.message;
    if (message !== undefined) problems[field] = message.endsWith('.') ? message : `${message}.`;
  }
  return problems;
}

export type ProfileSave =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'queued'; readonly note: string }
  | { readonly kind: 'error'; readonly message: string; readonly field?: ProfileField };

export async function saveProfile(
  store: MutationStore,
  saved: ProfileValues,
  edited: ProfileValues,
  options?: SubmitOptions,
): Promise<ProfileSave> {
  const changes = profileChanges(saved, edited);
  if (Object.keys(changes).length === 0) return { kind: 'skipped' };
  if (Object.keys(profileProblems(edited)).length > 0) return { kind: 'skipped' };
  const result = await submitMutation(store, userUpdateProfile, changes, options);
  switch (result.kind) {
    case 'confirmed':
      return { kind: 'saved' };
    case 'queued':
      return { kind: 'queued', note: PROFILE_QUEUED_NOTE };
    case 'rejected': {
      // On the field the server names (e.g. E5: someone has the display name); else the form's.
      const field = result.issues
        ?.map((issue) => issue.path[0])
        .find((name): name is ProfileField => FIELDS.some((known) => known === name));
      return field === undefined
        ? { kind: 'error', message: result.message }
        : { kind: 'error', message: result.message, field };
    }
    case 'failed':
      return { kind: 'error', message: result.message };
  }
}

export type ImageChange = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** Uploads `file` and makes it your avatar; the upload is cropped square by the server. */
export async function changeAvatar(
  api: Pick<SettingsApi, 'upload'>,
  store: MutationStore,
  file: Blob,
  options?: SubmitOptions,
): Promise<ImageChange> {
  const uploaded = await api.upload(file, 'avatar');
  if (!uploaded.ok) return uploaded;
  return outcome(await submitMutation(store, userUpdateProfile, { avatar: uploaded.id }, options));
}

export async function removeAvatar(
  store: MutationStore,
  options?: SubmitOptions,
): Promise<ImageChange> {
  return outcome(await submitMutation(store, userUpdateProfile, { avatar: null }, options));
}

function outcome(result: Awaited<ReturnType<typeof submitMutation>>): ImageChange {
  return result.kind === 'rejected' || result.kind === 'failed'
    ? { ok: false, message: result.message }
    : { ok: true };
}
