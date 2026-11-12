// Settings → Security's password change (SPEC-001 §3.5, E10; PLAN-001 S6), apart from React. It
// asks for the current password and the new one twice; the server checks the current one and
// logs out the other sessions, so the sessions list reloads after.
import { newPasswordProblem } from '../account/submit.js';
import type { SettingsApi } from '../files/api.js';

export type PasswordField = 'currentPassword' | 'newPassword';

export type PasswordView =
  | { readonly phase: 'editing'; readonly busy: boolean; readonly problem?: PasswordProblem }
  | { readonly phase: 'changed'; readonly endedSessions: number };

export type PasswordProblem = { readonly field: PasswordField | null; readonly message: string };

export const PASSWORD_EDITING: PasswordView = { phase: 'editing', busy: false };

export function changedText(endedSessions: number): string {
  if (endedSessions === 0) return 'Password changed.';
  if (endedSessions === 1) return 'Password changed. 1 other session was logged out.';
  return `Password changed. ${endedSessions} other sessions were logged out.`;
}

export async function changePassword(
  api: Pick<SettingsApi, 'changePassword'>,
  values: { readonly current: string; readonly next: string; readonly again: string },
): Promise<PasswordView> {
  if (values.current === '') {
    return editing({ field: 'currentPassword', message: 'Enter your current password.' });
  }
  const problem = newPasswordProblem(values.next, values.again);
  if (problem !== null) return editing({ field: 'newPassword', message: problem });
  const answer = await api.changePassword(values.current, values.next);
  if (answer.ok) return { phase: 'changed', endedSessions: answer.result.endedSessions };
  const field =
    answer.field === 'currentPassword' || answer.field === 'newPassword' ? answer.field : null;
  return editing({ field, message: answer.message });
}

const editing = (problem: PasswordProblem): PasswordView => ({
  phase: 'editing',
  busy: false,
  problem,
});
