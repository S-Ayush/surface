// Route guards (SPEC-005 §3): setup incomplete → /setup; signed out → /login?next=…; admin-only
// routes for Members → not-found (never revealing they exist). "Store not ready" is not a
// redirect: the shell renders with a bootstrap progress bar (app/ShellRoute.tsx).

/** Who may open a route (checked before it loads). Admin-only pages check `adminAccess`. */
export type Access =
  /** /setup: only while setup is incomplete. */
  | 'setup'
  /** Sign-in and invite pages: anyone, without the shell. */
  | 'public'
  /** The shell's pages. */
  | 'signed-in';

export type GuardState = {
  readonly setupComplete: boolean;
  readonly signedIn: boolean;
  /** Signed out by the user's own logout, not a revoked or missing session. */
  readonly loggedOut?: boolean;
};

export type GuardResult =
  { readonly kind: 'allow' } | { readonly kind: 'redirect'; readonly to: string };

export type AdminAccess =
  | { readonly kind: 'allow' }
  | { readonly kind: 'not-found' }
  /** The answer needs the store (the user's role): show a spinner. */
  | { readonly kind: 'wait' };

export const HOME = '/';
export const LOGIN = '/login';
export const SETUP = '/setup';

const isControl = (char: string) => {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

/** The path of an address, without its query or fragment, in lower case (routes match any case). */
const pathOf = (address: string) => (address.split(/[?#]/, 1)[0] ?? address).toLowerCase();

const isLoginPage = (address: string) => {
  const path = pathOf(address);
  return path === LOGIN || path.startsWith(`${LOGIN}/`);
};

/**
 * A `next` target that stays in this app: a path starting with one `/` (not `//host` or `/\host`,
 * which browsers treat as another origin), without control characters, and not a login page.
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.length === 0 || raw.length > 2048) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  if ([...raw].some(isControl)) return null;
  if (isLoginPage(raw)) return null;
  return raw;
}

/** The login URL that brings the user back to `path` afterwards. */
export function loginFor(path: string): string {
  const next = safeNext(path);
  return next === null || next === HOME ? LOGIN : `${LOGIN}?next=${encodeURIComponent(next)}`;
}

export function guard(
  access: Access,
  /** `path`: the whole address (query included), so `next` keeps it; `next`: the login page's. */
  location: { readonly path: string; readonly next?: string | null },
  state: GuardState,
): GuardResult {
  if (!state.setupComplete) {
    return access === 'setup' ? { kind: 'allow' } : { kind: 'redirect', to: SETUP };
  }
  if (access === 'setup') return { kind: 'redirect', to: state.signedIn ? HOME : LOGIN };
  if (access === 'public') {
    // Signed in already: the login page sends the user on to where they were going.
    if (state.signedIn && pathOf(location.path) === LOGIN) {
      return { kind: 'redirect', to: safeNext(location.next) ?? HOME };
    }
    return { kind: 'allow' };
  }
  if (!state.signedIn) {
    // After their own logout the next sign-in starts at home (it may be someone else).
    return { kind: 'redirect', to: state.loggedOut === true ? LOGIN : loginFor(location.path) };
  }
  return { kind: 'allow' };
}

/** An admin-only page for a signed-in user: not-found for a Member, wait until the role is known. */
export function adminAccess(admin: boolean | undefined): AdminAccess {
  if (admin === undefined) return { kind: 'wait' };
  return admin ? { kind: 'allow' } : { kind: 'not-found' };
}
