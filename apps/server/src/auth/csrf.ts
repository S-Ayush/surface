/**
 * CSRF protection for cookie-authenticated requests (ADR-0007, PLAN-001 S3): a signed
 * double-submit token. The token is an HMAC of the session id under `SESSION_SECRET`, so the
 * server stores nothing and a token is good for one session only. The client reads it from the
 * `surface_csrf` cookie (not HttpOnly, on purpose) and sends it back in `X-CSRF-Token`; another
 * site can make the browser send the cookie, but can't read it to set the header.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CSRF_COOKIE } from '@surface/sync-protocol';
import { SESSION_TTL_MS } from './session.js';

export function csrfToken(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url');
}

export function csrfTokenMatches(secret: string, sessionId: string, sent: unknown): boolean {
  if (typeof sent !== 'string') return false;
  const expected = Buffer.from(csrfToken(secret, sessionId));
  const actual = Buffer.from(sent);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Readable by the page's script (no HttpOnly); otherwise like the session cookie. */
export function csrfCookie(token: string, { secure }: { secure: boolean }): string {
  const attributes = [
    `${CSRF_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_MS / 1000}`,
    'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}
