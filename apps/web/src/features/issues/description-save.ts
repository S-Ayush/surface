// The description's save controller (SPEC-012 §3.4 item 3, AC-12, E5; SPEC-011 §3.3, D17;
// PLAN-012 S4b). Pure of React and of the store: the page feeds it what the user types and what
// the replica holds, and it decides when to send `issue.updateDescription`.
//
// - Saves after 2 s without typing, on blur, on `Mod+Enter` and when the page is hidden or closed,
//   only when the text differs from what it was based on (D17: a same-text save would only raise
//   the version).
// - One save in flight. A save asked for meanwhile waits and is sent after the first is
//   confirmed, from the version that save made (its `baseVersion` + 1: the server raises it by
//   exactly one).
// - **Never sends on a predicted version** (SPEC-012 D31). While a change to this description that
//   isn't this saver's own save is unconfirmed (an earlier page's save still queued, or the
//   issue's create), the replica's version is the overlay's prediction: the saver keeps the text
//   and sends nothing. Once it is confirmed or refused, the replica holds the server's row: when
//   its text is what the saver was building on, saves continue from its version; otherwise the
//   conflict banner shows (that save was refused, or someone saved after it).
// - On `CONFLICT` (someone saved in between) the user's text stays, a queued save is dropped, not
//   sent, and nothing more is saved until **Discard and reload** (D17: a second save on a stale
//   base could otherwise overwrite the other person's text).
// - A remote save while the user has unsaved text keeps the text (E5); the next save gets the
//   conflict. Without unsaved text the editor takes the remote text and version.
import { DESCRIPTION_MESSAGES, sameDocJson, type DocNodeJSON } from '@surface/domain';

/** SPEC-012 §3.4 item 3: the idle time before a save. */
export const DESCRIPTION_IDLE_MS = 2000;

/** A description and the version it has on the server. */
export interface SavedDescription {
  readonly doc: DocNodeJSON;
  readonly version: number;
}

/** How one `issue.updateDescription` ended. */
export type DescriptionSendResult =
  | { readonly kind: 'confirmed' }
  /** A stale `baseVersion`: someone saved since (SPEC-011 §6.4). */
  | { readonly kind: 'conflict' }
  /** Any other refusal: the text stays, the next edit tries again. The shell reports it too once
   * the page is closed (`shown()`), so the saver reports it only while attached. */
  | { readonly kind: 'refused'; readonly message: string };

export interface DescriptionTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DescriptionSaveDeps {
  /**
   * Sends one save. `shown()` says, when asked, whether the page is still attached and shows a
   * refusal itself (the banner or a toast); after it closed, the shell's toast should. A send
   * that throws never reached the store, so the saver reports it whether attached or not.
   */
  send(
    input: { baseVersion: number; description: DocNodeJSON },
    shown: () => boolean,
  ): Promise<DescriptionSendResult>;
  readonly timers: DescriptionTimers;
  /** A refusal that isn't the conflict: the page toasts its message. */
  onRefused?(message: string): void;
}

export interface DescriptionSaveState {
  /** What the editor shows: the user's text, or the replica's when there is nothing unsaved. */
  readonly doc: DocNodeJSON;
  /** The conflict banner is up (§3.4 item 3). */
  readonly conflict: boolean;
  /** A save is in flight. */
  readonly saving: boolean;
  /** The text differs from what it is based on. */
  readonly dirty: boolean;
}

/** The outcome of a dispatch, mapped: the stale-base `CONFLICT` is the banner, the rest a toast. */
export function descriptionSendResult(
  outcome:
    | { readonly status: 'confirmed' }
    | { readonly status: 'rejected'; readonly error: { code: string; message: string } },
): DescriptionSendResult {
  if (outcome.status === 'confirmed') return { kind: 'confirmed' };
  // An archived or deleted issue is `CONFLICT` too, with its own message ("ENG-42 was deleted.
  // Restore it to edit it."): that is a refusal to show, not the description banner.
  if (outcome.error.code === 'CONFLICT' && outcome.error.message === DESCRIPTION_MESSAGES.stale) {
    return { kind: 'conflict' };
  }
  return { kind: 'refused', message: outcome.error.message };
}

/** The store's queue as the saver reads it (`SyncStore.pending`). */
export interface PendingChange {
  readonly op: string;
  readonly input?: unknown;
}

/**
 * How many unconfirmed changes in the queue change `issueId`'s description: its saves and its
 * create (which writes the first `IssueContent`, SPEC-011 §6.2). Their versions in the replica are
 * predictions until they are confirmed.
 */
export function unconfirmedDescriptionChanges(
  pending: readonly PendingChange[],
  issueId: string,
): number {
  const id = issueId.toLowerCase();
  let count = 0;
  for (const { op, input } of pending) {
    const key = op === 'issue.updateDescription' ? 'issue' : op === 'issue.create' ? 'id' : null;
    if (key === null || typeof input !== 'object' || input === null) continue;
    const value: unknown = Reflect.get(input, key);
    if (typeof value === 'string' && value.toLowerCase() === id) count += 1;
  }
  return count;
}

export class DescriptionSaver {
  readonly #deps: DescriptionSaveDeps;
  /** What the user's text is based on: the last description loaded or confirmed. */
  #base: SavedDescription;
  /** `#base` was read while another change to it was unconfirmed: its version is a prediction. */
  #predicted: boolean;
  /** The replica's latest description (it may be newer than `#base`, or predicted). */
  #remote: SavedDescription;
  /** Unconfirmed changes to this description in the store, this saver's own save included. */
  #unconfirmed: number;
  #doc: DocNodeJSON;
  #inFlight = false;
  #queued = false;
  #conflict = false;
  #attached = false;
  #timer: unknown = undefined;
  #state: DescriptionSaveState;
  readonly #listeners = new Set<() => void>();

  /** `unconfirmed`: how many changes to this description the store holds unconfirmed. */
  constructor(initial: SavedDescription, deps: DescriptionSaveDeps, unconfirmed = 0) {
    this.#deps = deps;
    this.#base = initial;
    this.#remote = initial;
    this.#unconfirmed = unconfirmed;
    this.#predicted = unconfirmed > 0;
    this.#doc = initial.doc;
    this.#state = this.#snapshot();
  }

  /** The current state; the same object until something changes (`useSyncExternalStore`). */
  readonly getState = (): DescriptionSaveState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The user typed. In conflict nothing is saved until the banner is answered. */
  edit(doc: DocNodeJSON): void {
    this.#doc = doc;
    this.#emit();
    this.#clearTimer();
    if (this.#conflict || !this.#dirty()) return;
    this.#arm();
  }

  /** The editor lost focus: save now. */
  blur(): void {
    this.saveNow();
  }

  /** Blur, `Mod+Enter`, the idle timer, the page hidden or closed. */
  saveNow(): void {
    this.#clearTimer();
    if (this.#conflict || !this.#dirty()) return;
    // One in flight; and nothing goes out on a predicted version: it waits for the confirmation.
    if (this.#inFlight || this.#blocked()) {
      this.#queued = true;
      return;
    }
    void this.#send();
  }

  /**
   * The replica's description and how many changes to it are unconfirmed, read together (a
   * remote save, this tab's own save arriving, an earlier save confirmed or refused).
   */
  remote(content: SavedDescription, unconfirmed = 0): void {
    this.#remote = content;
    this.#unconfirmed = unconfirmed;
    this.#settle(false);
  }

  /** **Discard and reload**: the replica's current description and version (AC-12). */
  discardAndReload(): void {
    this.#clearTimer();
    this.#conflict = false;
    this.#queued = false;
    this.#base = this.#remote;
    this.#predicted = this.#blocked();
    this.#doc = this.#remote.doc;
    this.#emit();
  }

  /**
   * The page shows this description (an effect). The returned detach is the page closing: what
   * is unsaved is sent now, and nothing waits on a timer; a save already in flight still sends a
   * queued one after it. React's StrictMode may detach and attach again.
   */
  attach(): () => void {
    this.#attached = true;
    return () => {
      this.#attached = false;
      this.dispose();
    };
  }

  /** Send what is unsaved now; nothing waits on a timer. Safe to call more than once. */
  dispose(): void {
    this.saveNow();
  }

  /** A change to this description other than this saver's own save is unconfirmed. */
  #blocked(): boolean {
    return this.#unconfirmed > (this.#inFlight ? 1 : 0);
  }

  async #send(): Promise<void> {
    const sent = this.#doc;
    const baseVersion = this.#base.version;
    this.#inFlight = true;
    this.#emit();
    let result: DescriptionSendResult;
    let reported: boolean;
    try {
      result = await this.#deps.send({ baseVersion, description: sent }, () => this.#attached);
      // The store reports a refusal itself once the page is closed (`reportRejection`).
      reported = this.#attached;
    } catch (error) {
      result = {
        kind: 'refused',
        message:
          error instanceof Error ? error.message : "Couldn't save the description. Try again.",
      };
      // It never reached the store, so nothing else will say so.
      reported = true;
    }
    this.#inFlight = false;
    if (result.kind === 'conflict') {
      // D17: never send the queued save; its base is stale too.
      this.#enterConflict();
      return;
    }
    if (result.kind === 'refused') {
      this.#queued = false;
      if (reported) this.#deps.onRefused?.(result.message);
      this.#emit();
      return;
    }
    // The server raised the version by one from the base this save was sent with.
    this.#base = { doc: sent, version: baseVersion + 1 };
    this.#predicted = false;
    this.#settle(true);
  }

  /**
   * After a confirmation or a replica change: check a predicted base once nothing else is
   * unconfirmed, send what waited, follow the replica when nothing is unsaved. `confirmed`: this
   * saver's own save was just confirmed.
   */
  #settle(confirmed: boolean): void {
    if (this.#inFlight || this.#conflict) {
      this.#emit();
      return;
    }
    if (this.#blocked()) {
      // The replica shows the unconfirmed change; with nothing unsaved, show it too, but never
      // save on its version.
      if (!this.#dirty()) {
        this.#base = this.#remote;
        this.#doc = this.#remote.doc;
        this.#predicted = true;
      }
      this.#emit();
      return;
    }
    if (this.#predicted) {
      // Nothing else is unconfirmed, so the replica holds the server's row.
      const server = this.#remote;
      this.#predicted = false;
      if (!sameDocJson(server.doc, this.#base.doc) && !sameDocJson(server.doc, this.#doc)) {
        // The text this saver built on was refused, or overwritten since: D17's banner.
        this.#enterConflict();
        return;
      }
      this.#base = server;
    }
    if (this.#queued) {
      this.#queued = false;
      if (this.#dirty()) {
        void this.#send();
        return;
      }
    }
    this.#reconcile();
    // Unsaved text with nothing scheduled after a confirmation (typed back to the old base while
    // the save was in flight): the idle timer picks it up. A refused save waits for the next edit.
    if (confirmed && this.#dirty() && this.#timer === undefined) this.#arm();
    this.#emit();
  }

  /** Without unsaved text, follow the replica (E5's other half). */
  #reconcile(): void {
    if (this.#dirty()) return;
    const remote = this.#remote;
    // An older answer (the replica not caught up with this tab's confirmed save) is ignored.
    if (remote.version < this.#base.version) return;
    if (remote.version === this.#base.version && sameDocJson(remote.doc, this.#base.doc)) return;
    this.#base = remote;
    this.#doc = remote.doc;
  }

  #enterConflict(): void {
    this.#conflict = true;
    this.#queued = false;
    this.#clearTimer();
    this.#emit();
  }

  #arm(): void {
    this.#timer = this.#deps.timers.setTimeout(() => {
      this.#timer = undefined;
      this.saveNow();
    }, DESCRIPTION_IDLE_MS);
  }

  #dirty(): boolean {
    return !sameDocJson(this.#doc, this.#base.doc);
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    this.#deps.timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #snapshot(): DescriptionSaveState {
    return {
      doc: this.#doc,
      conflict: this.#conflict,
      saving: this.#inFlight,
      dirty: this.#dirty(),
    };
  }

  #emit(): void {
    const next = this.#snapshot();
    const now = this.#state;
    if (
      next.doc === now.doc &&
      next.conflict === now.conflict &&
      next.saving === now.saving &&
      next.dirty === now.dirty
    ) {
      return;
    }
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
