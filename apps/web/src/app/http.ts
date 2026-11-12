// The web app's HTTP plumbing for a signed-in browser (SPEC-001 §6.1, E14).
//
// - `csrfFetch` is for the web app's own writes (`/api/ops/*`, `POST /auth/logout`): it sends the
//   CSRF token, and on `403 CSRF_INVALID` gets the session (which sets the cookie again) and
//   resends once.
// - `watchSession` is for the sync client's requests: it only reports a `401`. The sync client
//   renews its CSRF token itself (session D), so wrapping it in `csrfFetch` would renew twice and
//   send up to four mutate requests per attempt.
import { CSRF_COOKIE, CSRF_HEADER, CSRF_INVALID, SESSION_PATH } from '@surface/sync-protocol';
import { z } from 'zod';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The value of cookie `name` in a `document.cookie` string; undefined if missing or empty. */
export function cookieValue(cookies: string, name: string): string | undefined {
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (raw === '') return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** SPEC-003's error answer; only the parts the client reads. */
const ErrorBody = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});

/**
 * An error answer's code and message, read from a copy so the caller can still read the body;
 * undefined when the body isn't SPEC-003's error shape (a proxy's page, say).
 */
export async function errorOf(
  response: Response,
): Promise<{ readonly code: string; readonly message: string } | undefined> {
  try {
    const body = ErrorBody.safeParse(await response.clone().json());
    return body.success ? body.data.error : undefined;
  } catch {
    return undefined;
  }
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Sends the CSRF token on writes, and resends once after a stale-token refusal. */
export function csrfFetch(fetchFn: FetchLike, cookies: () => string): FetchLike {
  const send = (url: string, init: RequestInit | undefined) => {
    if (READS.has((init?.method ?? 'GET').toUpperCase())) return fetchFn(url, init);
    const headers = new Headers(init?.headers);
    const token = cookieValue(cookies(), CSRF_COOKIE);
    if (token !== undefined) headers.set(CSRF_HEADER, token);
    return fetchFn(url, { ...init, headers });
  };
  return async (url, init) => {
    const response = await send(url, init);
    if (response.status !== 403 || (await errorOf(response))?.code !== CSRF_INVALID)
      return response;
    // One retry per request, never nested (SPEC-001 §6.1). Signed out: the refusal stands.
    const session = await fetchFn(SESSION_PATH, { headers: { accept: 'application/json' } });
    if (!session.ok) return response;
    return send(url, init);
  };
}

/**
 * Reports a `401` (the session ended: E14) with the request's URL, and passes every answer
 * through. Never resends.
 */
export function watchSession(
  fetchFn: FetchLike,
  onUnauthenticated: (url: string) => void,
): FetchLike {
  return async (url, init) => {
    const response = await fetchFn(url, init);
    if (response.status === 401) onUnauthenticated(url);
    return response;
  };
}
