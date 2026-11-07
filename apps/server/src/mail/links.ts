/**
 * The links Surface emails or shows for copying (SPEC-001 §3.2–3.4), on `SURFACE_URL`, the one
 * origin people must use (SPEC-004 E3). The token is a credential: request logs mask it
 * (`redactUrl`), and email jobs carry it sealed.
 */

/**
 * The page `/login/magic?token=…`, which logs in with `POST /auth/magic` (SPEC-001 §3.2). Not under
 * `/auth/`: those paths are the server's API, never a page (`http/static.ts`, the dev proxy).
 */
export function magicLinkUrl(publicUrl: string, token: string): string {
  const url = new URL('/login/magic', publicUrl);
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
