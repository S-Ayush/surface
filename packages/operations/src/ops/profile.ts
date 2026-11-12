/**
 * Your own account (SPEC-001 §3.5, §6.2; PLAN-001 S6): who you are, your profile, your password.
 * Each acts on the signed-in actor only ("self" in §6.2): nobody edits another user's profile.
 */
import {
  canonicalTimeZone,
  DISPLAY_NAME_MAX_LENGTH,
  displayNameProblem,
  FileRef,
  NAME_MAX_LENGTH,
  nameProblem,
  parseIdRef,
  PASSWORD_MAX_LENGTH,
  passwordProblem,
  timeZoneProblem,
} from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import type { StoreRow } from '../optimistic.js';
import { UserSchema } from './member.js';

/** A string field checked by a `@surface/domain` rule, so every client shows the same words. */
const checked = (max: number, problem: (value: string) => string | undefined) =>
  z
    .string()
    .max(max)
    .superRefine((value, ctx) => {
      const found = problem(value);
      if (found !== undefined) ctx.addIssue({ code: 'custom', message: found });
    });

export const ProfileName = checked(NAME_MAX_LENGTH.person * 4, (name) =>
  nameProblem('Name', name, NAME_MAX_LENGTH.person),
);
export const ProfileDisplayName = checked(DISPLAY_NAME_MAX_LENGTH * 4, displayNameProblem);
export const ProfileTimeZone = checked(100, timeZoneProblem);

export const userMe = defineOperation({
  name: 'user.me',
  kind: 'query',
  domain: 'user',
  summary: 'Get your own account',
  description:
    'Returns the signed-in user: email, name, display name, avatar, time zone and role. Same as user.get with "me".',
  keywords: ['who am i', 'my account', 'my profile', 'current user'],
  input: z.object({}),
  output: UserSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{}],
});

/** The id a `FileRef` names (ids only), or undefined. */
function fileIdOf(ref: string | undefined): string | undefined {
  const parsed = ref === undefined ? undefined : parseIdRef(ref);
  return parsed?.by === 'id' ? parsed.id : undefined;
}

const idOf = (row: StoreRow | undefined): string | undefined =>
  typeof row?.['id'] === 'string' ? row['id'] : undefined;

export const userUpdateProfile = defineOperation({
  name: 'user.updateProfile',
  kind: 'mutation',
  domain: 'user',
  summary: 'Update your profile',
  description:
    'Changes your own name, display name (unique, like ada.l), avatar or time zone (an IANA name, like Europe/Berlin). Only the given fields change. The avatar is a file id from POST /files/upload, or null to remove it.',
  keywords: ['edit profile', 'change name', 'change display name', 'change avatar', 'time zone'],
  input: z.object({
    name: ProfileName.optional(),
    displayName: ProfileDisplayName.optional(),
    avatar: FileRef.nullable().optional(),
    timezone: ProfileTimeZone.optional(),
  }),
  output: UserSchema,
  // Anyone signed in, for their own row only: the handler writes the actor's user row.
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ timezone: 'Europe/Berlin' }, { name: 'Ada Lovelace', avatar: null }],
  // Live in every client (AC-15): the user row is synced, so the change shows at once. A display
  // name someone else has is the server's to refuse (E5); the overlay then rolls back.
  optimistic: (store, input) => {
    const me = idOf(store.get('User', 'me'));
    if (me === undefined) return;
    const avatarFileId = input.avatar === null ? null : fileIdOf(input.avatar);
    store.patch('User', me, {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() }),
      ...(avatarFileId === undefined ? {} : { avatarFileId }),
      ...(input.timezone === undefined ? {} : { timezone: canonicalTimeZone(input.timezone) }),
      updatedAt: store.now.toISOString(),
    });
  },
});

/** Its current value must match the seed fixture's credential (server `test/seed.ts`). */
const EXAMPLE_CURRENT_PASSWORD = 'seed-password-not-secret';

export const userChangePassword = defineOperation({
  name: 'user.changePassword',
  kind: 'mutation',
  domain: 'user',
  summary: 'Change your password',
  description:
    'Sets a new password for your account, after checking your current one. Logs out your other sessions; this one stays signed in. The new password needs at least 10 characters.',
  keywords: ['change password', 'new password', 'update password'],
  input: z.object({
    currentPassword: z.string().max(PASSWORD_MAX_LENGTH * 2),
    newPassword: checked(PASSWORD_MAX_LENGTH * 2, passwordProblem),
  }),
  output: z.object({
    /** How many other sessions were logged out. */
    endedSessions: z.number().int().nonnegative(),
  }),
  permission: (p) => p.any(),
  // It ends sessions: every one of them for an API key (M6), as `session.revokeOthers` does.
  destructive: true,
  examples: [
    { currentPassword: EXAMPLE_CURRENT_PASSWORD, newPassword: 'a-new-example-passphrase' },
  ],
});
