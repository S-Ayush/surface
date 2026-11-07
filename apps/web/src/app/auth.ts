// The app's view of authentication (SPEC-001 §3.2, §6.1; SPEC-005 §3 guards), over PLAN-001 S3's
// routes. The guards read `AuthState.snapshot`; signing in, signing out and a session the server
// ended change it, and the router re-runs the guards (`followAuth`).
import { SESSION_PATH } from '@surface/sync-protocol';
import { observable, runInAction } from 'mobx';
import { z } from 'zod';
import { csrfFetch, errorOf, type FetchLike } from './http.js';

/** `GET /auth/capabilities` (SPEC-001 §6.1). */
export type Capabilities = { readonly setupComplete: boolean; readonly smtp: boolean };

/** The signed-in user: what the client store needs to open the replica (SPEC-002 §5). */
export type Session = { readonly userId: string; readonly workspaceId: string };

/** A sign-in attempt: the message is for the user (the server's, or how to recover). */
export type LoginResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface AuthClient {
  capabilities(): Promise<Capabilities>;
  /** The current session, or null when signed out. */
  session(): Promise<Session | null>;
  login(email: string, password: string): Promise<LoginResult>;
  logout(): Promise<void>;
}

export type AuthSnapshot =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly capabilities: Capabilities;
      readonly session: Session | null;
      /** The session ended by the user's own logout (the next sign-in starts at home). */
      readonly loggedOut?: boolean;
      /**
       * Counts the sessions this page has had. A new one means a new client store, even for the
       * same user: the old store's socket was closed for good (4001).
       */
      readonly epoch: number;
    }
  | { readonly status: 'failed'; readonly message: string };

const UNREACHABLE = "Surface can't reach the server. Check your connection, then reload the page.";
/** How long a 4001 check waits before its second look (see `recheck`). */
const SECOND_LOOK_MS = 1000;
export const LOGIN_FAILED = "Couldn't log in. Check your connection, then try again.";

/** The auth state the router's guards read; loaded once, then changed by sign-in and sign-out. */
export class AuthState {
  readonly #client: AuthClient;
  readonly #snapshot = observable.box<AuthSnapshot>({ status: 'loading' }, { deep: false });
  #loading: Promise<AuthSnapshot> | undefined;
  /** Logouts in flight: while any is, it decides how the session ends, not a 4001 or a 401. */
  #loggingOut = 0;
  readonly #wait: () => Promise<void>;

  constructor(client: AuthClient, options: { readonly wait?: () => Promise<void> } = {}) {
    this.#client = client;
    this.#wait =
      options.wait ?? (() => new Promise((resolve) => setTimeout(resolve, SECOND_LOOK_MS)));
  }

  get snapshot(): AuthSnapshot {
    return this.#snapshot.get();
  }

  /**
   * Loads capabilities and the session once, then resolves to the current snapshot: after a
   * sign-out that is the signed-out state, not the first load.
   */
  async ready(): Promise<AuthSnapshot> {
    this.#loading ??= this.#load();
    await this.#loading;
    return this.snapshot;
  }

  /** Signs in, then reads the session back (the guards send the user on to `next`). */
  async login(email: string, password: string): Promise<LoginResult> {
    const result = await this.#client.login(email, password);
    if (!result.ok) return result;
    const session = await this.#client.session().catch(() => null);
    if (session === null) return { ok: false, message: LOGIN_FAILED };
    this.#begin(session);
    return { ok: true };
  }

  /**
   * The session may have ended: its socket closed with 4001 (E10), or a request got 401 (E14).
   * Signing in again, in this tab or another, also ends the previous session (SPEC-001 Q11), so
   * both ask who is signed in now: still someone, and the shell reopens with a new store; nobody
   * (or no answer), and the guards send to /login?next=.
   *
   * - "Nobody" gets a second look after a short wait: the 4001 or 401 can come before the
   *   browser has stored the new session's cookie, so the first check may carry the old one.
   * - `epoch` is the session the caller's store was opened for (default: the current one). A
   *   check from an earlier session's store, or answered after the session changed, does nothing.
   */
  async recheck(epoch?: number): Promise<void> {
    const checked = this.#epoch();
    if (checked === undefined || (epoch !== undefined && epoch !== checked)) return;
    const ask = () => this.#client.session().catch(() => null);
    const current = () => this.#loggingOut === 0 && this.#epoch() === checked;
    let session = await ask();
    if (session === null && current()) {
      await this.#wait();
      session = await ask();
    }
    // A late answer is about a session that has gone: the user logged out meanwhile (logging out
    // closes this tab's socket too), or signed in again and the check carried the old cookie.
    if (!current()) return;
    if (session === null) this.#end(false);
    else this.#begin(session);
  }

  async logout(): Promise<void> {
    this.#loggingOut += 1;
    try {
      await this.#client.logout();
      this.#end(true);
    } catch (error) {
      // The answer may be lost after the server acted (its 4001 is ignored meanwhile): if the
      // session is gone, the logout happened.
      const session = await this.#client.session().catch(() => undefined);
      if (session !== null) throw error;
      this.#end(true);
    } finally {
      this.#loggingOut -= 1;
    }
  }

  /** The current session's epoch; undefined when signed out or not loaded. */
  #epoch(): number | undefined {
    const current = this.snapshot;
    return current.status === 'ready' && current.session !== null ? current.epoch : undefined;
  }

  #begin(session: Session): void {
    const current = this.snapshot;
    if (current.status !== 'ready') return;
    runInAction(() =>
      this.#snapshot.set({ ...current, session, loggedOut: false, epoch: current.epoch + 1 }),
    );
  }

  #end(loggedOut: boolean): void {
    const current = this.snapshot;
    if (current.status !== 'ready') return;
    runInAction(() => this.#snapshot.set({ ...current, session: null, loggedOut }));
  }

  async #load(): Promise<AuthSnapshot> {
    let next: AuthSnapshot;
    try {
      const [capabilities, session] = await Promise.all([
        this.#client.capabilities(),
        this.#client.session(),
      ]);
      next = { status: 'ready', capabilities, session, epoch: 0 };
    } catch {
      next = { status: 'failed', message: UNREACHABLE };
    }
    runInAction(() => this.#snapshot.set(next));
    return next;
  }
}

// SPEC-001 §6.1: every auth route answers SPEC-003's `{ ok: true, result }`.
const ok = <T extends z.ZodType>(result: T) => z.object({ ok: z.literal(true), result });
const CapabilitiesBody = ok(z.object({ smtp: z.boolean(), setupComplete: z.boolean() }));
const SessionBody = ok(z.object({ userId: z.string(), workspaceId: z.string() }));

const JSON_ACCEPT = { accept: 'application/json' };

/** PLAN-001 S3's routes. `cookies` reads `document.cookie`, for the CSRF token on sign-out. */
export function httpAuthClient(fetchFn: FetchLike, cookies: () => string): AuthClient {
  const writes = csrfFetch(fetchFn, cookies);
  return {
    capabilities: async () => {
      const response = await fetchFn('/auth/capabilities', { headers: JSON_ACCEPT });
      if (!response.ok) throw new Error(`capabilities ${String(response.status)}`);
      return CapabilitiesBody.parse(await response.json()).result;
    },
    session: async () => {
      const response = await fetchFn(SESSION_PATH, { headers: JSON_ACCEPT });
      if (response.ok) return SessionBody.parse(await response.json()).result;
      if (response.status === 401) return null;
      // Before setup no one can be signed in; the guards send every page to /setup.
      if (response.status === 503 && (await errorOf(response))?.code === 'SETUP_REQUIRED') {
        return null;
      }
      throw new Error(`session ${String(response.status)}`);
    },
    login: async (email, password) => {
      let response: Response;
      try {
        response = await fetchFn('/auth/login', {
          method: 'POST',
          headers: { ...JSON_ACCEPT, 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
      } catch {
        return { ok: false, message: LOGIN_FAILED };
      }
      if (response.ok) return { ok: true };
      // A refusal's message says what to do (wrong password, locked for N minutes: E13), shown
      // as it is. A server failure's is never shown (SPEC-003: 5xx hide internals).
      const error = response.status < 500 ? await errorOf(response) : undefined;
      return { ok: false, message: error?.message ?? LOGIN_FAILED };
    },
    logout: async () => {
      const response = await writes('/auth/logout', { method: 'POST', headers: JSON_ACCEPT });
      if (!response.ok) throw new Error(`logout ${String(response.status)}`);
    },
  };
}
