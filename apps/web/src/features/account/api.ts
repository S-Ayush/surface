// The magic-link and reset routes (SPEC-001 §6.1; PLAN-001 S4). Writes go through `csrfFetch`:
// a browser that is still signed in sends a session cookie, so it needs the CSRF token too.
import { createContext, useContext } from 'react';
import { csrfFetch, errorOf, type FetchLike } from '../../app/http.js';

export type AccountResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export type LinkKind = 'magicLink' | 'passwordReset';

export interface AccountApi {
  /** Asks for a login or reset link. The answer is the same whether the account exists. */
  requestLink(kind: LinkKind, email: string): Promise<AccountResult>;
  /** Signs in with a login link's token. */
  signInWithLink(token: string): Promise<AccountResult>;
  /** Sets a new password with a reset link's token, and signs in. */
  resetPassword(token: string, password: string): Promise<AccountResult>;
}

export const UNREACHABLE = "Couldn't reach Surface. Check your connection, then try again.";

const PATHS: Readonly<Record<LinkKind, string>> = {
  magicLink: '/auth/magic-link',
  passwordReset: '/auth/forgot',
};

export function httpAccountApi(fetchFn: FetchLike, cookies: () => string): AccountApi {
  const send = csrfFetch(fetchFn, cookies);
  const post = async (path: string, body: object): Promise<AccountResult> => {
    let response: Response;
    try {
      response = await send(path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, message: UNREACHABLE };
    }
    if (response.ok) return { ok: true };
    // A refusal says what to do (a used link, a short password); a server failure's message is
    // never shown (SPEC-003: 5xx hide internals).
    const error = response.status < 500 ? await errorOf(response) : undefined;
    return { ok: false, message: error?.message ?? UNREACHABLE };
  };
  return {
    requestLink: (kind, email) => post(PATHS[kind], { email: email.trim() }),
    signInWithLink: (token) => post('/auth/magic', { token }),
    resetPassword: (token, password) => post('/auth/reset', { token, password }),
  };
}

const browserApi = (): AccountApi =>
  httpAccountApi(
    (url, init) => window.fetch(url, init),
    () => document.cookie,
  );

/** The API the account screens use; tests provide a fake. */
export const AccountApiContext = createContext<AccountApi | null>(null);

export function useAccountApi(): AccountApi {
  const provided = useContext(AccountApiContext);
  return provided ?? lazyBrowserApi;
}

// Built on first use, so rendering on the server (tests) never touches `window`.
let cached: AccountApi | undefined;
const lazyBrowserApi: AccountApi = {
  requestLink: (kind, email) => (cached ??= browserApi()).requestLink(kind, email),
  signInWithLink: (token) => (cached ??= browserApi()).signInWithLink(token),
  resetPassword: (token, password) => (cached ??= browserApi()).resetPassword(token, password),
};

/**
 * After signing in with a link the page loads again from the start: the app reads the new
 * session as on any first load, so no screen has to know how the shell opens.
 */
export function enterApp(): void {
  window.location.assign('/');
}
