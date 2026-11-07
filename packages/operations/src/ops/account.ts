/**
 * Account operations (SPEC-001 §3.3, §3.5, §6.2). PLAN-001 S4: `user.createResetLink`, the
 * Admin's way to reset a password when the server has no email (AC-3). S6 adds the user's own
 * account operations here.
 */
import { UserRef } from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';

export const userCreateResetLink = defineOperation({
  name: 'user.createResetLink',
  kind: 'mutation',
  domain: 'user',
  summary: 'Generate a password reset link',
  description:
    'Returns a one-time link that lets a person choose a new password, valid for 1 hour. It is shown only this once: copy it and send it to them. Their earlier reset links stop working, and using it logs them out everywhere. Admins only. Accepts a user email, display name or id.',
  keywords: ['reset password', 'password reset link', 'forgot password', 'locked out'],
  input: z.object({ user: UserRef }),
  output: z.object({
    url: z.url().meta({ description: 'The reset link. Treat it like a password.' }),
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  permission: (p) => p.admin(),
  destructive: false,
  examples: [{ user: 'iris@example.com' }],
});
