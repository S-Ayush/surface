// The app's view of authentication (SPEC-001 §3.2, §6.1; SPEC-005 §3 guards), over PLAN-001 S3's
// routes. The guards read `AuthState.snapshot`; signing in, signing out and a session the server
// ended change it, and the router re-runs the guards (`followAuth`). A reload while the server
// can't be reached opens the session this device last had (ADR-0018, SPEC-002 AC-6).
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
      /**
       * The session is this device's last one, opened because the server couldn't be reached
       * at load (ADR-0018). It is checked again, and confirmed or ended, once the server answers.
       */
      readonly offline?: boolean;
    }
  | { readonly status: 'failed'; readonly message: string };

/** The server couldn't be reached: no answer, a 5xx, or none within `CHECK_TIMEOUT_MS`. */
export class UnreachableError extends Error {
  override readonly name = 'UnreachableError';
  constructor(cause?: unknown) {
    super('The server could not be reached', { cause });
  }
}

/** What a reload needs to open the replica without the server: ids and a flag, no secrets. */
export type RememberedStart = { readonly session: Session; readonly smtp: boolean };

/** This device's last session (ADR-0018). Written while signed in, cleared when it ends. */
export interface StartMemory {
  read(): RememberedStart | undefined;
  write(start: RememberedStart): void;
  clear(): void;
  /**
   * A logout the server hasn't heard of yet: the user logged out with no way to reach it, so the
   * HttpOnly session cookie still lives. A flag, no secret. While set, nothing signs the user back
   * in: the next contact sends `POST /auth/logout` first (SPEC-012 §3.12 item 2). Without these
   * three, the flag lives in this page only.
   */
  logoutPending?(): boolean;
  setLogoutPending?(pending: boolean): void;
  /** Calls `listener` when another tab changes the flag (the `storage` event). */
  watchLogoutPending?(listener: () => void): () => void;
}

const forgetful: StartMemory = {
  read: () => undefined,
  write: () => undefined,
  clear: () => undefined,
};

const START_KEY = 'surface.last-session';
const LOGOUT_KEY = 'surface.logout-pending';
const RememberedStartSchema = z.object({
  session: z.object({ userId: z.string(), workspaceId: z.string() }),
  smtp: z.boolean(),
});

/**
 * `StartMemory` in `localStorage`. Storage that is blocked or full is treated as empty: the app
 * then needs the server to load, as before ADR-0018.
 */
export function browserStartMemory(
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  events:
    Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | undefined = typeof window ===
  'undefined'
    ? undefined
    : window,
): StartMemory {
  return {
    logoutPending: () => {
      try {
        return storage().getItem(LOGOUT_KEY) !== null;
      } catch {
        return false;
      }
    },
    setLogoutPending: (pending) => {
      try {
        if (pending) storage().setItem(LOGOUT_KEY, '1');
        else storage().removeItem(LOGOUT_KEY);
      } catch {
        // Not kept: this page still knows, and a reload then relies on the session's expiry.
      }
    },
    watchLogoutPending: (listener) => {
      const onStorage = (event: Event) => {
        // `key` is null when the whole storage was cleared.
        const key = event instanceof StorageEvent ? event.key : null;
        if (key === LOGOUT_KEY || key === null) listener();
      };
      events?.addEventListener('storage', onStorage);
      return () => {
        events?.removeEventListener('storage', onStorage);
      };
    },
    read: () => {
      try {
        const raw = storage().getItem(START_KEY);
        if (raw === null) return undefined;
        const parsed = RememberedStartSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },
    write: (start) => {
      try {
        storage().setItem(START_KEY, JSON.stringify(start));
      } catch {
        // Not kept, and the last session forgotten rather than kept for someone else: the next
        // reload without the server shows the error page.
        try {
          storage().removeItem(START_KEY);
        } catch {
          // Storage that can't be written can't be cleared either; read() then finds nothing.
        }
      }
    },
    clear: () => {
      try {
        storage().removeItem(START_KEY);
      } catch {
        // Nothing could have been kept either.
      }
    },
  };
}

/** Waits between checks of a remembered session: 2, 5, 10, then every 30 s (ADR-0018). */
export const RETRY_MS: readonly number[] = [2000, 5000, 10_000, 30_000];

/**
 * Waits before the `attempt`th check, cut short when `browser` (the window) says it is online
 * again.
 */
export function waitToRetry(
  attempt: number,
  browser: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window,
): Promise<void> {
  const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 30_000;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      browser.removeEventListener('online', done);
      resolve();
    };
    const timer = setTimeout(done, delay);
    browser.addEventListener('online', done);
  });
}

const UNREACHABLE = "Surface can't reach the server. Check your connection, then reload the page.";
/** How long a 4001 check waits before its second look (see `recheck`). */
const SECOND_LOOK_MS = 1000;
/**
 * A store that a 4001 closes sooner than this after it opened was closed "at once": reopening the
 * same session again and again backs off (see `recheck`). It matches the longest `RETRY_MS` wait.
 */
export const REOPEN_WINDOW_MS = RETRY_MS.at(-1) ?? 30_000;
export const LOGIN_FAILED = "Couldn't log in. Check your connection, then try again.";

/** The auth state the router's guards read; loaded once, then changed by sign-in and sign-out. */
export class AuthState {
  readonly #client: AuthClient;
  readonly #snapshot = observable.box<AuthSnapshot>({ status: 'loading' }, { deep: false });
  #loading: Promise<AuthSnapshot> | undefined;
  /** Logouts in flight: while any is, it decides how the session ends, not a 4001 or a 401. */
  #loggingOut = 0;
  readonly #wait: () => Promise<void>;
  readonly #memory: StartMemory;
  readonly #retry: (attempt: number) => Promise<void>;
  readonly #now: () => number;
  /** When the current session's store was opened (its epoch began). */
  #openedAt = 0;
  /** The current session reopened this many times in a row, each soon after the last. */
  #reopens = 0;
  /** The epoch whose store a check is already reopening: a store is reopened once. */
  #reopening: number | undefined;
  /** The logout flag when the memory can't keep it (see `StartMemory.logoutPending`). */
  #logoutPending = false;
  /** The `POST /auth/logout` that is flushing a pending logout, so there is only one. */
  #flushing: Promise<boolean> | undefined;

  constructor(
    client: AuthClient,
    options: {
      readonly wait?: () => Promise<void>;
      /** This device's last session; none by default (tests, and before ADR-0018). */
      readonly memory?: StartMemory;
      /**
       * The wait before each check of a remembered session, and before reopening a session
       * that keeps being revoked at once (default: `waitToRetry`).
       */
      readonly retry?: (attempt: number) => Promise<void>;
      /** The clock for `REOPEN_WINDOW_MS` (default: `Date.now`). */
      readonly now?: () => number;
      /** Where `online` fires, to send a pending logout (default: the window). */
      readonly network?: Pick<EventTarget, 'addEventListener'>;
    } = {},
  ) {
    this.#client = client;
    this.#wait =
      options.wait ?? (() => new Promise((resolve) => setTimeout(resolve, SECOND_LOOK_MS)));
    this.#memory = options.memory ?? forgetful;
    this.#retry = options.retry ?? waitToRetry;
    this.#now = options.now ?? Date.now;
    const network = options.network ?? (typeof window === 'undefined' ? undefined : window);
    network?.addEventListener('online', () => {
      void this.#flushLogout();
    });
    // Another tab logged out with no way to reach the server: this tab's session is over too,
    // and the delete of the replica there must not wait for this tab (SPEC-012 §3.12 item 3).
    this.#memory.watchLogoutPending?.(() => {
      if (!this.#pending()) return;
      void this.#flushLogout();
      if (this.#loggingOut === 0 && this.#epoch() !== undefined) this.#end(true);
    });
  }

  #pending(): boolean {
    return this.#memory.logoutPending?.() ?? this.#logoutPending;
  }

  #setPending(pending: boolean): void {
    this.#logoutPending = pending;
    this.#memory.setLogoutPending?.(pending);
  }

  /**
   * Sends a logout the server hasn't heard of. True once none is pending. The flag clears only
   * when the server answers, and `/auth/logout` answers 200 whether or not the session is still
   * there, so a failure here only means "no contact yet".
   */
  #flushLogout(): Promise<boolean> {
    if (!this.#pending()) return Promise.resolve(true);
    this.#flushing ??= this.#client.logout().then(
      () => {
        this.#setPending(false);
        return true;
      },
      () => false,
    );
    const flushing = this.#flushing;
    void flushing.then(() => {
      if (this.#flushing === flushing) this.#flushing = undefined;
    });
    return flushing;
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
    // The old user's session must be over on the server before anyone signs in (§3.12 item 2).
    if (!(await this.#flushLogout())) return { ok: false, message: LOGIN_FAILED };
    const result = await this.#client.login(email, password);
    if (!result.ok) return result;
    const session = await this.#client.session().catch(() => null);
    if (session === null) return { ok: false, message: LOGIN_FAILED };
    this.#reopens = 0;
    this.#begin(session);
    return { ok: true };
  }

  /**
   * The session may have ended: its socket closed with 4001 (E10), or a request got 401 (E14).
   * Signing in again, in this tab or another, also ends the previous session (SPEC-001 Q11), so
   * both ask who is signed in now: still someone, and the shell reopens with a new store; nobody
   * (or a wrong answer), and the guards send to /login?next=. A server that can't be reached
   * says nothing about the session: it is kept, and the next 4001 or 401 asks again (ADR-0018).
   *
   * - "Nobody" gets a second look after a short wait: the 4001 or 401 can come before the
   *   browser has stored the new session's cookie, so the first check may carry the old one.
   * - `epoch` is the session the caller's store was opened for (default: the current one). A
   *   check from an earlier session's store, or answered after the session changed, does nothing.
   * - `cause`: `unauthorized` is a 401 the store recovers from by itself (a mutate: the queue
   *   parks, redials and resends after its own backoff, SPEC-002 E14), so the same session keeps
   *   the store; a new one would resend at once, looping against a server or proxy that disagrees
   *   with itself. `revoked` (a 4001, whose socket is closed for good, or a bootstrap 401) needs
   *   a new store, but reopening the same session soon after the last one waits first, as
   *   `RETRY_MS`, then asks again (`app/session-store.ts` picks the cause).
   */
  async recheck(epoch?: number, cause: 'revoked' | 'unauthorized' = 'revoked'): Promise<void> {
    const checked = this.#epoch();
    if (checked === undefined || (epoch !== undefined && epoch !== checked)) return;
    // undefined: no answer, so nothing is known about the session.
    const ask = () =>
      this.#client
        .session()
        .catch((error: unknown) => (error instanceof UnreachableError ? undefined : null));
    const current = () => this.#loggingOut === 0 && this.#epoch() === checked;
    let session = await ask();
    if (session === null && current()) {
      await this.#wait();
      session = await ask();
    }
    // A late answer is about a session that has gone: the user logged out meanwhile (logging out
    // closes this tab's socket too), or signed in again and the check carried the old cookie.
    if (!current() || session === undefined) return;
    if (session !== null && this.#isCurrent(session)) {
      if (cause === 'unauthorized') return;
      if (this.#reopening === checked) return;
      this.#reopening = checked;
      const attempt = this.#reopenAttempt();
      if (attempt !== undefined) {
        await this.#retry(attempt);
        if (!current()) return;
        // The answer is up to 30 s old by now: whoever is signed in now gets the new store.
        session = await ask();
        if (!current() || session === undefined) return;
      }
    }
    if (session === null) {
      this.#end(false);
      return;
    }
    if (!this.#isCurrent(session)) this.#reopens = 0;
    this.#begin(session);
  }

  #isCurrent(session: Session): boolean {
    const current = this.snapshot;
    return (
      current.status === 'ready' &&
      current.session !== null &&
      current.session.userId === session.userId &&
      current.session.workspaceId === session.workspaceId
    );
  }

  /**
   * Counts a reopen of the same session. The first one soon after the last opening is at once
   * (undefined); each further one waits `RETRY_MS[attempt]`: 2, 5, 10, then 30 s.
   */
  #reopenAttempt(): number | undefined {
    const soon = this.#now() - this.#openedAt < REOPEN_WINDOW_MS;
    this.#reopens = soon ? this.#reopens + 1 : 0;
    return this.#reopens < 2 ? undefined : this.#reopens - 2;
  }

  /**
   * A logout the server can't be told about (no answer to it or to the session check) still ends
   * the session here, and leaves a flag: the next contact sends `POST /auth/logout` before
   * anything else, because the session cookie is HttpOnly and would sign the user back in
   * (SPEC-012 §3.12 item 2). A server that answers with a refusal keeps the session.
   */
  async logout(): Promise<void> {
    this.#loggingOut += 1;
    try {
      await this.#client.logout();
      this.#end(true);
    } catch (error) {
      // The answer may be lost after the server acted (its 4001 is ignored meanwhile): if the
      // session is gone, the logout happened.
      let unreachable = false;
      const session = await this.#client.session().catch((reason: unknown) => {
        unreachable = reason instanceof UnreachableError;
        return undefined;
      });
      if (session !== null && !unreachable) throw error;
      if (session !== null) this.#setPending(true);
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

  #begin(session: Session, capabilities?: Capabilities): void {
    const current = this.snapshot;
    if (current.status !== 'ready') return;
    const next = {
      ...current,
      capabilities: capabilities ?? current.capabilities,
      session,
      loggedOut: false,
      epoch: current.epoch + 1,
      offline: false,
    };
    this.#memory.write({ session, smtp: next.capabilities.smtp });
    this.#openedAt = this.#now();
    runInAction(() => this.#snapshot.set(next));
  }

  #end(loggedOut: boolean): void {
    const current = this.snapshot;
    if (current.status !== 'ready') return;
    this.#memory.clear();
    runInAction(() => this.#snapshot.set({ ...current, session: null, loggedOut, offline: false }));
  }

  async #load(): Promise<AuthSnapshot> {
    let next: AuthSnapshot;
    // A logout that never reached the server: the session is still there, but the user left.
    const left = this.#pending();
    if (left && !(await this.#flushLogout())) {
      const capabilities = await this.#client
        .capabilities()
        .catch(() => ({ setupComplete: true, smtp: false }));
      next = { status: 'ready', capabilities, session: null, loggedOut: true, epoch: 0 };
      runInAction(() => this.#snapshot.set(next));
      return next;
    }
    try {
      const [capabilities, session] = await Promise.all([
        this.#client.capabilities(),
        this.#client.session(),
      ]);
      next = {
        status: 'ready',
        capabilities,
        session,
        epoch: 0,
        // The logout just sent: the next sign-in starts at home (it may be someone else).
        ...(left && session === null ? { loggedOut: true } : {}),
      };
      this.#openedAt = this.#now();
      if (session === null) this.#memory.clear();
      else this.#memory.write({ session, smtp: capabilities.smtp });
    } catch (error) {
      const remembered = error instanceof UnreachableError ? this.#memory.read() : undefined;
      next =
        remembered === undefined
          ? { status: 'failed', message: UNREACHABLE }
          : {
              status: 'ready',
              // Only a workspace that was set up has a session to remember.
              capabilities: { setupComplete: true, smtp: remembered.smtp },
              session: remembered.session,
              epoch: 0,
              offline: true,
            };
      // The store opens now, from the replica, whatever the server says later.
      this.#openedAt = this.#now();
    }
    runInAction(() => this.#snapshot.set(next));
    if (next.status === 'ready' && next.offline === true) void this.#confirm(next.epoch);
    return next;
  }

  /**
   * Checks a remembered session until the server answers (ADR-0018): the same session is
   * confirmed under the same epoch, so the shell keeps its store; nobody signed in ends it
   * (`/login?next=`); someone else opens theirs; an answer that is wrong rather than missing
   * shows the error page, as a reload would. Stops once the session changed some other way.
   */
  async #confirm(epoch: number): Promise<void> {
    const stillOffline = () => {
      const current = this.snapshot;
      return current.status === 'ready' && current.offline === true && current.epoch === epoch;
    };
    for (let attempt = 0; ; attempt += 1) {
      await this.#retry(attempt);
      if (!stillOffline()) return;
      if (this.#pending()) {
        if (!(await this.#flushLogout())) continue;
        this.#end(true);
        return;
      }
      let answer: [Capabilities, Session | null];
      try {
        answer = await Promise.all([this.#client.capabilities(), this.#client.session()]);
      } catch (error) {
        if (error instanceof UnreachableError) continue;
        if (stillOffline()) {
          runInAction(() => this.#snapshot.set({ status: 'failed', message: UNREACHABLE }));
        }
        return;
      }
      const current = this.snapshot;
      if (!stillOffline() || current.status !== 'ready') return;
      const [capabilities, session] = answer;
      if (session === null) {
        this.#end(false);
      } else if (
        current.session !== null &&
        session.userId === current.session.userId &&
        session.workspaceId === current.session.workspaceId
      ) {
        this.#memory.write({ session, smtp: capabilities.smtp });
        runInAction(() => this.#snapshot.set({ ...current, capabilities, offline: false }));
      } else {
        this.#begin(session, capabilities);
      }
      return;
    }
  }
}

// SPEC-001 §6.1: every auth route answers SPEC-003's `{ ok: true, result }`.
const ok = <T extends z.ZodType>(result: T) => z.object({ ok: z.literal(true), result });
const CapabilitiesBody = ok(z.object({ smtp: z.boolean(), setupComplete: z.boolean() }));
const SessionBody = ok(z.object({ userId: z.string(), workspaceId: z.string() }));

const JSON_ACCEPT = { accept: 'application/json' };

/** How long a check of capabilities or the session may take before the server counts as away. */
export const CHECK_TIMEOUT_MS = 10_000;

/**
 * A GET that fails as `UnreachableError` on no answer, no answer in time, or a 5xx other than
 * 503. A 503 is returned to the caller, which tells "not ready" from `SETUP_REQUIRED`.
 */
async function check(fetchFn: FetchLike, url: string): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, CHECK_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(url, { headers: JSON_ACCEPT, signal: abort.signal });
  } catch (error) {
    throw new UnreachableError(error);
  } finally {
    clearTimeout(timer);
  }
  if (response.status >= 500 && response.status !== 503) throw new UnreachableError();
  return response;
}

/** PLAN-001 S3's routes. `cookies` reads `document.cookie`, for the CSRF token on sign-out. */
export function httpAuthClient(fetchFn: FetchLike, cookies: () => string): AuthClient {
  const writes = csrfFetch(fetchFn, cookies);
  return {
    capabilities: async () => {
      const response = await check(fetchFn, '/auth/capabilities');
      if (response.status === 503) throw new UnreachableError();
      if (!response.ok) throw new Error(`capabilities ${String(response.status)}`);
      return CapabilitiesBody.parse(await response.json()).result;
    },
    session: async () => {
      const response = await check(fetchFn, SESSION_PATH);
      if (response.ok) return SessionBody.parse(await response.json()).result;
      if (response.status === 401) return null;
      if (response.status === 503) {
        // Before setup no one can be signed in; the guards send every page to /setup. Any
        // other 503 is a server not ready to answer.
        if ((await errorOf(response))?.code === 'SETUP_REQUIRED') return null;
        throw new UnreachableError();
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
