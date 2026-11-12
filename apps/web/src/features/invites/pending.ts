// Settings → Members' pending invites (SPEC-001 §3.4; PLAN-001 S5), apart from React so it tests
// without a browser. Invites aren't in the replica, so the list is read with `invite.list` when
// the screen opens and again after each change. Revoking asks the server, then reloads.
import type { Invite, InvitesApi } from './api.js';

export type PendingView = {
  readonly loading: boolean;
  readonly invites: readonly Invite[];
  /** More than one page: the list shows the newest only. */
  readonly more: boolean;
  readonly error: string | null;
  /** The invite being revoked. */
  readonly revoking: string | null;
};

export const PENDING_LOADING: PendingView = {
  loading: true,
  invites: [],
  more: false,
  error: null,
  revoking: null,
};

export class PendingInvites {
  #view: PendingView = PENDING_LOADING;
  /** Only the newest load shows: an older answer arriving late is dropped. */
  #loads = 0;

  constructor(
    private readonly api: Pick<InvitesApi, 'pending' | 'revoke'>,
    private readonly onView: (view: PendingView) => void,
  ) {}

  get view(): PendingView {
    return this.#view;
  }

  async load(): Promise<void> {
    const load = ++this.#loads;
    this.#show({ ...this.#view, loading: true });
    const result = await this.api.pending();
    if (load !== this.#loads) return;
    this.#show(
      result.ok
        ? { ...this.#view, loading: false, invites: result.invites, more: result.more, error: null }
        : { ...this.#view, loading: false, error: result.message },
    );
  }

  async revoke(inviteId: string): Promise<void> {
    if (this.#view.revoking !== null) return;
    this.#show({ ...this.#view, revoking: inviteId, error: null });
    const result = await this.api.revoke(inviteId);
    // Reload first: a successful reload clears errors, and a refusal must stay shown.
    await this.load();
    this.#show({
      ...this.#view,
      revoking: null,
      error: result.ok ? this.#view.error : result.message,
    });
  }

  #show(view: PendingView): void {
    this.#view = view;
    this.onView(view);
  }
}
