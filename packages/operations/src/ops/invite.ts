/**
 * Invite operations (SPEC-001 §3.4, §6.2; PLAN-001 S5). Admins invite people by link, emailed
 * when SMTP is set up and an email is given, and always shown for copying (E7, D7). Invites are
 * server-only: they never reach the replica, so the Members screen reads them with `invite.list`.
 * Accepting one is an HTTP route, not an operation: the invitee has no account yet (§6.1).
 */
import {
  EMAIL_MAX_LENGTH,
  emailProblem,
  INVITE_STATUSES,
  InviteRef,
  normaliseEmail,
  TeamRef,
  USER_ROLES,
} from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import { connectionOf, listInput } from '../list.js';
import { Timestamp } from './shared.js';

/** The most teams one invite adds the invitee to. */
export const INVITE_TEAMS_MAX = 50;

export const InviteSchema = z.object({
  id: z.uuid(),
  /** Lowercase; null for a link anyone may accept, who then enters their email. */
  email: z.string().nullable(),
  role: z.enum(USER_ROLES),
  /** Teams the invitee joins on accepting. */
  teamIds: z.array(z.uuid()),
  invitedById: z.uuid(),
  status: z.enum(INVITE_STATUSES),
  createdAt: Timestamp,
  expiresAt: Timestamp,
});

const InviteEmail = z
  .string()
  .max(EMAIL_MAX_LENGTH + 64)
  .superRefine((email, ctx) => {
    const problem = emailProblem(email);
    if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
  })
  .transform(normaliseEmail);

export const inviteCreate = defineOperation({
  name: 'invite.create',
  kind: 'mutation',
  domain: 'invite',
  summary: 'Invite someone to the workspace',
  description:
    'Creates an invite link that works for 7 days, as a Member or an Admin, optionally joining teams (keys or ids). With an email and SMTP set up, the link is also emailed. Returns the link: it is shown only once. Admins only. An email that already has an account is refused.',
  keywords: ['invite member', 'invite someone', 'add a person', 'send invite link'],
  input: z.object({
    email: InviteEmail.optional(),
    role: z.enum(USER_ROLES).default('member'),
    teams: z.array(TeamRef).max(INVITE_TEAMS_MAX).default([]),
  }),
  output: z.object({
    invite: InviteSchema,
    /** `/invite/<token>` on `SURFACE_URL`. Shown once: only the token's hash is stored. */
    url: z.url(),
    /** Whether the email was queued; sending happens later and is retried (SPEC-001 E7, D7). */
    emailed: z.boolean(),
  }),
  permission: (p) => p.admin(),
  destructive: false,
  examples: [{ email: 'new.person@example.com', role: 'member', teams: ['ENG'] }],
  ui: { title: 'Invite member…', icon: 'user-plus', contexts: ['global'], shortcut: null },
  // Invites never reach the replica, so there is nothing to predict (SPEC-001 D6).
  optimistic: () => undefined,
});

export const inviteList = defineOperation({
  name: 'invite.list',
  kind: 'query',
  domain: 'invite',
  summary: 'List invites',
  description:
    'Lists invites with their email, role, teams, status (pending, accepted, revoked, expired) and expiry. Filter by status, email, role, createdAt or expiresAt; sort by createdAt (default, newest first), expiresAt or email. Admins only.',
  keywords: ['list invites', 'pending invites', 'who was invited', 'open invitations'],
  input: z.object({ ...listInput }),
  output: connectionOf(InviteSchema),
  permission: (p) => p.admin(),
  destructive: false,
  examples: [{ filter: { field: 'status', op: 'eq', value: 'pending' } }],
});

export const inviteRevoke = defineOperation({
  name: 'invite.revoke',
  kind: 'mutation',
  domain: 'invite',
  summary: 'Revoke an invite',
  description:
    'Turns off a pending invite: its link then says the invite is no longer valid. Revoking a revoked or expired invite changes nothing; an accepted one is refused. Admins only. Takes an invite id from invite.list.',
  keywords: ['revoke invite', 'cancel invite', 'withdraw invitation', 'disable invite link'],
  input: z.object({ invite: InviteRef }),
  output: InviteSchema,
  permission: (p) => p.admin(),
  destructive: false,
  // The seed fixture's pending invite (apps/server/test/seed.ts).
  examples: [{ invite: '01930000-0000-7000-8000-000000000501' }],
});
