// Settings → Security's sessions (SPEC-001 §3.5, AC-8; PLAN-001 S6), apart from React so it
// tests without a browser. Sessions aren't in the replica: the list is read with `session.list`
// when the screen opens and after each change. Revoking asks the server, then reloads.
import type { Session, SettingsApi } from '../files/api.js';

export type SessionsView = {
  readonly loading: boolean;
  readonly sessions: readonly Session[];
  readonly more: boolean;
  readonly error: string | null;
  /** The session being revoked, or 'others' for "Revoke all others". */
  readonly revoking: string | null;
};

export const SESSIONS_LOADING: SessionsView = {
  loading: true,
  sessions: [],
  more: false,
  error: null,
  revoking: null,
};

export class SessionsFlow {
  #view: SessionsView = SESSIONS_LOADING;
  /** Only the newest load shows: an older answer arriving late is dropped. */
  #loads = 0;

  constructor(
    private readonly api: Pick<SettingsApi, 'sessions' | 'revokeSession' | 'revokeOtherSessions'>,
    private readonly onView: (view: SessionsView) => void,
  ) {}

  get view(): SessionsView {
    return this.#view;
  }

  async load(): Promise<void> {
    const load = ++this.#loads;
    this.#show({ ...this.#view, loading: true });
    const answer = await this.api.sessions();
    if (load !== this.#loads) return;
    this.#show(
      answer.ok
        ? { ...this.#view, loading: false, ...answer.result, error: null }
        : { ...this.#view, loading: false, error: answer.message },
    );
  }

  revoke(sessionId: string): Promise<void> {
    return this.#change(sessionId, () => this.api.revokeSession(sessionId));
  }

  revokeOthers(): Promise<void> {
    return this.#change('others', () => this.api.revokeOtherSessions());
  }

  async #change(
    which: string,
    send: () => Promise<{ readonly ok: boolean; readonly message?: string }>,
  ): Promise<void> {
    if (this.#view.revoking !== null) return;
    this.#show({ ...this.#view, revoking: which, error: null });
    const answer = await send();
    // Reload first: a successful reload clears errors, and a refusal must stay shown.
    await this.load();
    this.#show({
      ...this.#view,
      revoking: null,
      error: answer.ok ? this.#view.error : (answer.message ?? null),
    });
  }

  #show(view: SessionsView): void {
    this.#view = view;
    this.onView(view);
  }
}
