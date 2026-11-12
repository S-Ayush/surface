import { describe, expect, it } from 'vitest';
import { inviteStatus, INVITE_TTL_MS } from './invites.js';
import { LINK_LIFETIME_TEXT } from './links.js';

const NOW = new Date('2026-11-12T10:00:00Z');
const later = new Date(NOW.getTime() + 1000);

describe('inviteStatus (state-machines.md §6)', () => {
  it('is pending until accepted, revoked or past its expiry', () => {
    const pending = { acceptedAt: null, revokedAt: null, expiresAt: later };
    expect(inviteStatus(pending, NOW)).toBe('pending');
    expect(inviteStatus({ ...pending, expiresAt: NOW }, NOW)).toBe('expired');
    expect(inviteStatus({ ...pending, revokedAt: NOW }, NOW)).toBe('revoked');
    expect(inviteStatus({ ...pending, acceptedAt: NOW, expiresAt: NOW }, NOW)).toBe('accepted');
  });

  it('lasts the 7 days the email promises', () => {
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(LINK_LIFETIME_TEXT.invite).toBe('7 days');
  });
});
