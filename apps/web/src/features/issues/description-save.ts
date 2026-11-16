// The description's save controller (SPEC-012 §3.4 item 3, AC-12, E5; SPEC-011 §3.3, D17;
// PLAN-012 S4b). Pure of React and of the store: the page feeds it what the user types and what
// the replica holds, and it decides when to send `issue.updateDescription`.
//
// - Saves after 2 s without typing, on blur and on `Mod+Enter`, only when the text differs from
//   what it was based on (D17: a same-text save would only raise the version).
// - One save in flight. A save asked for meanwhile waits and is sent after the first is
//   confirmed, from the version that save made (its `baseVersion` + 1: the server raises it by
//   exactly one), never from a predicted one.
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
  /** Any other refusal, or the store didn't take it: the text stays, the next edit tries again. */
  | { readonly kind: 'refused'; readonly message: string };

export interface DescriptionTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DescriptionSaveDeps {
  /**
   * Sends one save. `shown()` says, when asked, whether the page is still attached and shows a
   * refusal itself (the banner or a toast); after it closed, the shell's toast should.
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

export class DescriptionSaver {
  readonly #deps: DescriptionSaveDeps;
  /** What the user's text is based on: the last description loaded or confirmed. */
  #base: SavedDescription;
  /** The replica's latest description (it may be newer than `#base`). */
  #remote: SavedDescription;
  #doc: DocNodeJSON;
  #inFlight = false;
  #queued = false;
  #conflict = false;
  #attached = false;
  #timer: unknown = undefined;
  #state: DescriptionSaveState;
  readonly #listeners = new Set<() => void>();

  constructor(initial: SavedDescription, deps: DescriptionSaveDeps) {
    this.#deps = deps;
    this.#base = initial;
    this.#remote = initial;
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
    this.#timer = this.#deps.timers.setTimeout(() => {
      this.#timer = undefined;
      this.saveNow();
    }, DESCRIPTION_IDLE_MS);
  }

  /** The editor lost focus: save now. */
  blur(): void {
    this.saveNow();
  }

  /** Blur, `Mod+Enter`, the idle timer, leaving the page. */
  saveNow(): void {
    this.#clearTimer();
    if (this.#conflict || !this.#dirty()) return;
    if (this.#inFlight) {
      this.#queued = true;
      return;
    }
    void this.#send();
  }

  /** The replica's description changed (a remote save, or this tab's own save arriving). */
  remote(content: SavedDescription): void {
    this.#remote = content;
    this.#reconcile();
  }

  /** **Discard and reload**: the replica's current description and version (AC-12). */
  discardAndReload(): void {
    this.#clearTimer();
    this.#conflict = false;
    this.#queued = false;
    this.#base = this.#remote;
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

  async #send(): Promise<void> {
    const sent = this.#doc;
    const baseVersion = this.#base.version;
    this.#inFlight = true;
    this.#emit();
    let result: DescriptionSendResult;
    try {
      result = await this.#deps.send({ baseVersion, description: sent }, () => this.#attached);
    } catch (error) {
      result = {
        kind: 'refused',
        message:
          error instanceof Error ? error.message : "Couldn't save the description. Try again.",
      };
    }
    this.#inFlight = false;
    if (result.kind === 'conflict') {
      // D17: never send the queued save; its base is stale too.
      this.#conflict = true;
      this.#queued = false;
      this.#clearTimer();
      this.#emit();
      return;
    }
    if (result.kind === 'refused') {
      this.#queued = false;
      this.#deps.onRefused?.(result.message);
      this.#emit();
      return;
    }
    // The server raised the version by one from the base this save was sent with.
    this.#base = { doc: sent, version: baseVersion + 1 };
    const again = this.#queued;
    this.#queued = false;
    if (again && this.#dirty()) {
      void this.#send();
      return;
    }
    this.#reconcile();
    this.#emit();
  }

  /** Without unsaved text and nothing in flight, follow the replica (E5's other half). */
  #reconcile(): void {
    if (this.#inFlight || this.#conflict || this.#dirty()) return;
    const remote = this.#remote;
    // An older answer (the replica not caught up with this tab's confirmed save) is ignored.
    if (remote.version < this.#base.version) return;
    if (remote.version === this.#base.version && sameDocJson(remote.doc, this.#base.doc)) return;
    this.#base = remote;
    this.#doc = remote.doc;
    this.#emit();
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
