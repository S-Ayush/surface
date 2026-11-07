// The shell's view of authentication (SPEC-001 §6, SPEC-005 §3 guards). The server side is
// PLAN-001 S3 (session A): until it lands there is no session to read, so `main.tsx` uses
// `preAuthClient` and every shell route leads to /login. The HTTP client is added with S3.
import { observable, runInAction } from 'mobx';
import { z } from 'zod';

/** `GET /auth/capabilities` (SPEC-001 §6). */
export type Capabilities = { readonly setupComplete: boolean; readonly smtp: boolean };

/** The signed-in user: what the client store needs to open the replica (SPEC-002 §5). */
export type Session = { readonly userId: string; readonly workspaceId: string };

export interface AuthClient {
  capabilities(): Promise<Capabilities>;
  /** The current session, or null when signed out. */
  session(): Promise<Session | null>;
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
    }
  | { readonly status: 'failed'; readonly message: string };

const UNREACHABLE = "Surface can't reach the server. Check your connection, then reload the page.";

/** The auth state the router's guards read; loaded once, then changed by sign-out. */
export class AuthState {
  readonly #client: AuthClient;
  readonly #snapshot = observable.box<AuthSnapshot>({ status: 'loading' }, { deep: false });
  #loading: Promise<AuthSnapshot> | undefined;

  constructor(client: AuthClient) {
    this.#client = client;
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

  /** The server ended the session (sign-out elsewhere, revoked, expired): guards send to /login. */
  signedOut(): void {
    this.#end(false);
  }

  async logout(): Promise<void> {
    await this.#client.logout();
    this.#end(true);
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
      next = { status: 'ready', capabilities, session };
    } catch {
      next = { status: 'failed', message: UNREACHABLE };
    }
    runInAction(() => this.#snapshot.set(next));
    return next;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// `GET /setup/status` (PLAN-001 S2): open before setup, unlike /auth/* (503 SETUP_REQUIRED).
const SETUP_STATUS = z.object({
  ok: z.literal(true),
  result: z.object({ complete: z.boolean() }),
});

/**
 * Until PLAN-001 S3 provides sessions and `/auth/capabilities`: the setup state from
 * `/setup/status`, nobody signed in, and no SMTP. Any failure reads as an unreachable server.
 */
export function preAuthClient(fetchFn: FetchLike): AuthClient {
  return {
    capabilities: async () => {
      const response = await fetchFn('/setup/status', { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`setup status ${String(response.status)}`);
      const body = SETUP_STATUS.parse(await response.json());
      return { setupComplete: body.result.complete, smtp: false };
    },
    session: () => Promise.resolve(null),
    logout: () => Promise.resolve(),
  };
}
