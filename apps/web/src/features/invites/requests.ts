// "Invite member…" from the command menu (PLAN-001 S5): it opens Settings → Members and asks the
// screen to open its invite modal. The ask waits here until a screen takes it, so it works both
// when Members is already open (a listener) and when it opens next (taken on mount). An ask no
// screen takes soon is dropped: the modal must not pop up on some later visit to Members.

type Listener = () => void;

/** How long an ask waits for Members to open. Navigating there takes well under a second. */
export const INVITE_REQUEST_TTL_MS = 5_000;

export class InviteRequests {
  /** When the waiting ask was made, or null. */
  #askedAt: number | null = null;
  readonly #listeners = new Set<Listener>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Ask for the invite modal: a listening screen opens it now, the next one on mount. */
  request(): void {
    if (this.#listeners.size === 0) {
      this.#askedAt = this.now();
      return;
    }
    for (const listener of this.#listeners) listener();
  }

  /** Whether a recent ask is waiting; taking it clears it. */
  take(): boolean {
    const askedAt = this.#askedAt;
    this.#askedAt = null;
    return askedAt !== null && this.now() - askedAt <= INVITE_REQUEST_TTL_MS;
  }

  /** Listen while mounted; returns the unsubscribe. */
  listen(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export const INVITE_REQUESTS = new InviteRequests();
