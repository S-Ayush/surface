/**
 * Invite rules shared by the server and the web (SPEC-001 §3.4, E3, E4; state-machines.md §6;
 * PLAN-001 S5). An invite is pending until it is accepted, revoked or past `expiresAt`: expiry is
 * read from the clock, never written by a job.
 */

export const INVITE_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

/** How long an invite link works (`LINK_LIFETIME_TEXT.invite` says it in words). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** E4: a used, revoked, expired or unknown link, all alike. */
export const INVITE_INVALID_MESSAGE = 'This invite is no longer valid. Ask an Admin for a new one.';

/** E3, when inviting or accepting with an email that has an account. */
export const EMAIL_TAKEN_MESSAGE = 'A user with this email already exists';

export function inviteStatus(
  invite: {
    readonly acceptedAt: Date | null;
    readonly revokedAt: Date | null;
    readonly expiresAt: Date;
  },
  now: Date,
): InviteStatus {
  if (invite.acceptedAt !== null) return 'accepted';
  if (invite.revokedAt !== null) return 'revoked';
  return invite.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending';
}
