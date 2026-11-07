/**
 * The CSRF token a signed-in page sends with every mutate request
 * (SPEC-001 §6.1, Q7). The server sets it in the `surface_csrf` cookie,
 * which the page can read.
 */
import { CSRF_COOKIE } from '@surface/sync-protocol';

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

/** The page's CSRF token; undefined outside a browser, or before sign-in. */
export function browserCsrfToken(): string | undefined {
  return typeof document === 'undefined' ? undefined : cookieValue(document.cookie, CSRF_COOKIE);
}
