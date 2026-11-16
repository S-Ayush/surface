// The description's save controller (SPEC-012 §3.4 item 3, AC-12, E5, D31; SPEC-011 §3.3, D17;
// PLAN-012 S4b). Pure of React and of the store: the page feeds it what the user types, and it
// watches the replica's row and the store's queue itself (`DescriptionSource`), so it keeps
// working after the page closed, until what it holds is sent.
//
// - Saves after 2 s without typing, on blur, on `Mod+Enter` and when the page is hidden or closed,
//   only when the text differs from what it was based on (D17: a same-text save would only raise
//   the version).
// - One save in flight. A save asked for meanwhile waits and is sent after the first is
//   confirmed, from the version that save made (its `baseVersion` + 1: the server raises it by
//   exactly one).
// - **Never sends on a predicted version** (D31). While a change to this description that isn't
//   one of this saver's own saves (known by their `(clientId, seq)`) is unconfirmed (an earlier
//   page's save still queued, or the issue's create), the replica's version is the overlay's
//   prediction: the saver keeps the text and sends nothing. Once it is confirmed or refused, the
//   replica holds the server's row: when its text is what the saver was building on, saves
//   continue from its version; with nothing unsaved the editor follows it (E5); otherwise the
//   banner shows (that save was refused, or someone saved after it).
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

/** One read of the replica's description and the store's queue, taken together. */
export interface DescriptionSnapshot {
  /** The replica's row; undefined when it holds none (the issue left the replica). */
  readonly saved: SavedDescription | undefined;
  /** `clientId:seq` of each unconfirmed change to this description in the queue. */
  readonly changes: readonly string[];
  /** The store's recent refusals of changes to this description, by `clientId:seq`. */
  readonly refusals: readonly { readonly key: string; readonly message: string }[];
}

/** The store as the saver watches it. */
export interface DescriptionSource {
  read(): DescriptionSnapshot;
  /** Calls `changed` after anything `read` reads may have changed; returns the stop. */
  watch(changed: () => void): () => void;
}

export interface DescriptionSaveDeps {
  /**
   * Sends one save. `shown()` says, when asked, whether the page is still attached and shows a
   * refusal itself (the banner or a toast); after it closed, the shell's toast should. `queued`
   * gets the mutation's `clientId:seq` (`DispatchOptions.onQueued`). A send that throws never
   * reached the store, so the saver reports it whether attached or not.
   */
  send(
    input: { baseVersion: number; description: DocNodeJSON },
    shown: () => boolean,
    queued: (key: string) => void,
  ): Promise<DescriptionSendResult>;
  readonly source: DescriptionSource;
  readonly timers: DescriptionTimers;
  /**
   * Runs a read after the store's changes settle (default: a microtask), so one read sees what a
   * sequence of actions did together (the queue and the overlay change in separate actions).
   */
  readonly schedule?: (run: () => void) => void;
  /** A refusal that isn't the conflict: the page toasts its message. */
  onRefused?(message: string): void;
}

export interface DescriptionSaveState {
  /** What the editor shows: the user's text, or the replica's when there is nothing unsaved. */
  readonly doc: DocNodeJSON;
  /** The banner is up (§3.4 item 3). */
  readonly conflict: boolean;
  /**
   * Why, when it isn't the stale base: an earlier save of this text was refused for another
   * reason (too long, the issue deleted), and its message says so.
   */
  readonly conflictMessage: string | undefined;
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

/** Whether a mutation changes `issueId`'s description: a save, or the create (SPEC-011 §6.2). */
export function changesDescription(op: string, input: unknown, issueId: string): boolean {
  const key = op === 'issue.updateDescription' ? 'issue' : op === 'issue.create' ? 'id' : null;
  if (key === null || typeof input !== 'object' || input === null) return false;
  const value: unknown = Reflect.get(input, key);
  return typeof value === 'string' && value.toLowerCase() === issueId.toLowerCase();
}

export class DescriptionSaver {
  readonly #deps: DescriptionSaveDeps;
  /** What the user's text is based on: the last description loaded or confirmed. */
  #base: SavedDescription;
  /** `#base` was read while another change to it was unconfirmed: its version is a prediction. */
  #predicted: boolean;
  /** The replica's latest description (it may be newer than `#base`, or predicted). */
  #remote: SavedDescription;
  /** Unconfirmed changes to this description that aren't this saver's, by `clientId:seq`. */
  #foreign: readonly string[];
  /** Every foreign change seen while predicted: a refusal among them explains a conflict. */
  readonly #seen = new Set<string>();
  /** This saver's own saves, by `clientId:seq`, until they are answered. */
  readonly #own = new Set<string>();
  #refusals: DescriptionSnapshot['refusals'] = [];
  #doc: DocNodeJSON;
  #inFlight = false;
  #queued = false;
  #conflict = false;
  #conflictMessage: string | undefined = undefined;
  #attached = false;
  #timer: unknown = undefined;
  #stopWatching: (() => void) | undefined = undefined;
  #readScheduled = false;
  #state: DescriptionSaveState;
  readonly #listeners = new Set<() => void>();

  /** `fallback`: the row the page rendered, if the store's read has none. */
  constructor(fallback: SavedDescription, deps: DescriptionSaveDeps) {
    this.#deps = deps;
    const snapshot = deps.source.read();
    const initial = snapshot.saved ?? fallback;
    this.#base = initial;
    this.#remote = initial;
    this.#foreign = snapshot.changes;
    this.#refusals = snapshot.refusals;
    this.#predicted = snapshot.changes.length > 0;
    for (const key of snapshot.changes) this.#seen.add(key);
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

  /** **Discard and reload**: the replica's current description and version (AC-12). */
  discardAndReload(): void {
    this.#clearTimer();
    this.#conflict = false;
    this.#conflictMessage = undefined;
    this.#queued = false;
    this.#base = this.#remote;
    this.#predicted = this.#blocked();
    this.#doc = this.#remote.doc;
    this.#emit();
  }

  /**
   * The page shows this description (an effect): the saver watches the store. The returned
   * detach is the page closing: what is unsaved is sent now, nothing waits on a timer, and the
   * saver keeps watching until what it holds is sent (a save in flight, one queued after it, or
   * one waiting for an earlier change's confirmation). React's StrictMode may detach and attach
   * again.
   */
  attach(): () => void {
    this.#attached = true;
    this.#stopWatching ??= this.#deps.source.watch(() => {
      this.#scheduleRead();
    });
    // Anything that changed between the page's render and now.
    this.#scheduleRead();
    return () => {
      this.#attached = false;
      this.saveNow();
      this.#stopWhenIdle();
    };
  }

  /** Whether the saver still watches the store (for tests: it must not leak). */
  get watching(): boolean {
    return this.#stopWatching !== undefined;
  }

  /** A change to this description other than this saver's own saves is unconfirmed. */
  #blocked(): boolean {
    return this.#foreign.length > 0;
  }

  #scheduleRead(): void {
    if (this.#readScheduled) return;
    this.#readScheduled = true;
    const run = () => {
      this.#readScheduled = false;
      this.#read();
    };
    if (this.#deps.schedule) this.#deps.schedule(run);
    else queueMicrotask(run);
  }

  #read(): void {
    if (this.#stopWatching === undefined) return;
    const snapshot = this.#deps.source.read();
    this.#refusals = snapshot.refusals;
    this.#foreign = snapshot.changes.filter((key) => !this.#own.has(key));
    for (const key of this.#foreign) this.#seen.add(key);
    // No row: the issue left the replica (the page goes read-only); keep what is held.
    if (snapshot.saved !== undefined) this.#remote = snapshot.saved;
    this.#settle(false);
  }

  async #send(): Promise<void> {
    const sent = this.#doc;
    const baseVersion = this.#base.version;
    this.#inFlight = true;
    this.#emit();
    let result: DescriptionSendResult;
    let reported: boolean;
    let key: string | undefined;
    try {
      result = await this.#deps.send(
        { baseVersion, description: sent },
        () => this.#attached,
        (queuedKey) => {
          key = queuedKey;
          this.#own.add(queuedKey);
        },
      );
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
    if (key !== undefined) this.#own.delete(key);
    this.#inFlight = false;
    if (result.kind === 'conflict') {
      // D17: never send the queued save; its base is stale too.
      this.#enterConflict(undefined);
      this.#stopWhenIdle();
      return;
    }
    if (result.kind === 'refused') {
      this.#queued = false;
      if (reported) this.#deps.onRefused?.(result.message);
      this.#emit();
      this.#stopWhenIdle();
      return;
    }
    // The server raised the version by one from the base this save was sent with.
    this.#base = { doc: sent, version: baseVersion + 1 };
    this.#predicted = false;
    this.#settle(true);
  }

  /**
   * After a confirmation or a read of the store: check a predicted base once nothing else is
   * unconfirmed, send what waited, follow the replica when nothing is unsaved. `confirmed`: this
   * saver's own save was just confirmed.
   */
  #settle(confirmed: boolean): void {
    if (this.#inFlight || this.#conflict) {
      this.#emit();
      this.#stopWhenIdle();
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
      const dirty = this.#dirty();
      if (
        dirty &&
        !sameDocJson(server.doc, this.#base.doc) &&
        !sameDocJson(server.doc, this.#doc)
      ) {
        // The text this saver built on was refused, or overwritten since: D17's banner, with the
        // refusal's own reason when it wasn't the stale base.
        this.#enterConflict(this.#refusalReason());
        this.#seen.clear();
        this.#stopWhenIdle();
        return;
      }
      // Building on the server's row; with nothing unsaved, showing it (E5).
      this.#base = server;
      if (!dirty) this.#doc = server.doc;
    }
    this.#seen.clear();
    if (this.#queued) {
      this.#queued = false;
      if (this.#dirty()) {
        void this.#send();
        return;
      }
    }
    this.#reconcile();
    // Unsaved text with nothing scheduled after a confirmation (typed back to the old base while
    // the save was in flight): the idle timer picks it up, or, once the page closed, a save now.
    if (confirmed && this.#dirty() && this.#timer === undefined) {
      if (this.#attached) this.#arm();
      else {
        this.saveNow();
        if (this.#inFlight) return;
      }
    }
    this.#emit();
    this.#stopWhenIdle();
  }

  /** A refusal of an earlier change that isn't the stale base: its message. */
  #refusalReason(): string | undefined {
    for (const { key, message } of this.#refusals) {
      if (this.#seen.has(key) && message !== DESCRIPTION_MESSAGES.stale) return message;
    }
    return undefined;
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

  /** Once the page closed and nothing is in flight or waiting to be sent, stop watching. */
  #stopWhenIdle(): void {
    if (this.#attached || this.#stopWatching === undefined) return;
    const waiting = this.#queued && !this.#conflict && this.#dirty();
    if (this.#inFlight || waiting) return;
    this.#clearTimer();
    this.#stopWatching();
    this.#stopWatching = undefined;
  }

  #enterConflict(message: string | undefined): void {
    this.#conflict = true;
    this.#conflictMessage = message;
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
      conflictMessage: this.#conflictMessage,
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
      next.conflictMessage === now.conflictMessage &&
      next.saving === now.saving &&
      next.dirty === now.dirty
    ) {
      return;
    }
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
