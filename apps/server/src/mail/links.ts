/**
 * The links Surface emails or shows for copying (SPEC-001 §3.2–3.4), on `SURFACE_URL`, the one
 * origin people must use (SPEC-004 E3). The token is a credential: request logs mask it
 * (`redactUrl`), and email jobs carry it sealed.
 */

/** `GET /auth/magic?token=…` logs in (SPEC-001 §3.2). */
export function magicLinkUrl(publicUrl: string, token: string): string {
  const url = new URL('/auth/magic', publicUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

/** `/reset?token=…` sets a new password (SPEC-001 §3.3). */
export function passwordResetUrl(publicUrl: string, token: string): string {
  const url = new URL('/reset', publicUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

/** `/invite/:token` accepts an invite (SPEC-001 §3.4). */
export function inviteUrl(publicUrl: string, token: string): string {
  return new URL(`/invite/${encodeURIComponent(token)}`, publicUrl).toString();
}
