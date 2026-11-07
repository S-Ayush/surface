/**
 * CSRF for cookie-authenticated requests (SPEC-001 §6.1, Q7). Every unsafe
 * request a signed-in browser makes, `POST /sync/mutate` included, sends the
 * `surface_csrf` cookie's value in the `X-CSRF-Token` header.
 */

/** Request header carrying the token. */
export const CSRF_HEADER = 'x-csrf-token';

/** Cookie the server sets at sign-in, setup and `GET /auth/session`; readable by the page. */
export const CSRF_COOKIE = 'surface_csrf';

/**
 * SPEC-003 HTTP-layer code, with status `403`: the token is missing or does
 * not match the session. The client fetches `SESSION_PATH`, which sets the
 * cookie again, and resends once.
 */
export const CSRF_INVALID = 'CSRF_INVALID';

/** `GET`: who is signed in; also sets the CSRF cookie again (SPEC-001 §6.1). */
export const SESSION_PATH = '/auth/session';
