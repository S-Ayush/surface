// SPEC-012 §3.4 item 3, AC-12, E5, D31; SPEC-011 D17; PLAN-012 S4b: the description's save
// controller with a fake store source, a fake dispatcher and fake timers. Saves after 2 s idle or
// on blur with the `baseVersion` it was loaded from; one save in flight; a queued save is dropped
// on CONFLICT, never sent; only changed text is saved; "Discard and reload" takes the replica's
// version; never a predicted version; it keeps watching the store after the page closed until
// what it holds is sent.
import { DESCRIPTION_MESSAGES, EMPTY_DOC, type DocNodeJSON } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import {
  changesDescription,
  DESCRIPTION_IDLE_MS,
  DescriptionSaver,
  descriptionSendResult,
  type DescriptionSendResult,
  type DescriptionSnapshot,
  type DescriptionSource,
  type SavedDescription,
} from '../src/features/issues/description-save.js';

const doc = (text: string): DocNodeJSON => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Timers the test runs by hand. */
class Timers {
  #next = 1;
  readonly pending = new Map<number, { run: () => void; ms: number }>();
  setTimeout = (run: () => void, ms: number): unknown => {
    const handle = this.#next++;
    this.pending.set(handle, { run, ms });
    return handle;
  };
  clearTimeout = (handle: unknown): void => {
    if (typeof handle === 'number') this.pending.delete(handle);
  };
  /** Runs every timer due by `ms` (all are one-shot at the idle time here). */
  advance(ms: number): void {
    for (const [handle, timer] of [...this.pending]) {
      if (timer.ms > ms) continue;
      this.pending.delete(handle);
      timer.run();
    }
  }
}

/** The store as the saver watches it: one snapshot, changed by the test. */
class FakeSource implements DescriptionSource {
  snapshot: DescriptionSnapshot;
  readonly #listeners = new Set<() => void>();
  constructor(saved: SavedDescription, changes: readonly string[]) {
    this.snapshot = { saved, changes, refusals: [] };
  }
  read = (): DescriptionSnapshot => this.snapshot;
  watch = (changed: () => void): (() => void) => {
    this.#listeners.add(changed);
    return () => {
      this.#listeners.delete(changed);
    };
  };
  get watchers(): number {
    return this.#listeners.size;
  }
  /** One change to the replica and the queue (one delta, one rollback). */
  set(next: Partial<DescriptionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of [...this.#listeners]) listener();
  }
}

/**
 * A saver attached to a fake page. Its sends behave like the store's queue: each gets a key and
 * stays in `changes` until answered; a confirmation puts the saved row in the replica.
 */
function world(
  initial: SavedDescription = { doc: doc('First'), version: 3 },
  changes: readonly string[] = [],
) {
  const timers = new Timers();
  const source = new FakeSource(initial, changes);
  const sent: { baseVersion: number; description: DocNodeJSON }[] = [];
  const answers: {
    key: string;
    input: { baseVersion: number; description: DocNodeJSON };
    resolve: (result: DescriptionSendResult) => void;
  }[] = [];
  const refused: string[] = [];
  let seq = 0;
  const saver = new DescriptionSaver(initial, {
    source,
    timers,
    schedule: (run) => {
      run();
    },
    send: (input, _shown, queued) => {
      sent.push(input);
      seq += 1;
      const key = `tab-1:${seq}`;
      queued(key);
      source.set({ changes: [...source.snapshot.changes, key] });
      return new Promise((resolve) => answers.push({ key, input, resolve }));
    },
    onRefused: (message) => refused.push(message),
  });
  const detach = saver.attach();
  /**
   * Answers the oldest save as the store would: its entry leaves the queue (with `alongside`
   * applied in the same delta), then the dispatch settles and the continuation runs.
   */
  const answer = async (
    result: DescriptionSendResult,
    alongside: Partial<DescriptionSnapshot> = {},
  ) => {
    const next = answers.shift();
    if (next === undefined) throw new Error('nothing in flight');
    source.set({
      changes: source.snapshot.changes.filter((key) => key !== next.key),
      ...(result.kind === 'confirmed'
        ? {
            saved: {
              doc: next.input.description,
              version: next.input.baseVersion + 1,
            },
          }
        : {}),
      ...alongside,
    });
    next.resolve(result);
    await Promise.resolve();
    await Promise.resolve();
  };
  /** A change from elsewhere: someone's save, another tab's, an earlier page's queued save. */
  const remote = (
    saved: SavedDescription,
    changes: readonly string[] = source.snapshot.changes,
  ) => {
    source.set({ saved, changes });
  };
  return {
    timers,
    source,
    sent,
    saver,
    answer,
    remote,
    detach,
    refused,
    inFlight: () => answers.length,
  };
}

describe('saving the description (AC-12)', () => {
  it('saves after 2 s without typing, with the baseVersion it was loaded from', () => {
    const { timers, sent, saver } = world();
    saver.edit(doc('Second'));
    timers.advance(DESCRIPTION_IDLE_MS - 1);
    expect(sent).toEqual([]);
    saver.edit(doc('Second draft'));
    // Typing restarts the wait.
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([DESCRIPTION_IDLE_MS]);
    timers.advance(DESCRIPTION_IDLE_MS);
    expect(sent).toEqual([{ baseVersion: 3, description: doc('Second draft') }]);
  });

  it('saves on blur at once, and the idle timer then sends nothing more', () => {
    const { timers, sent, saver } = world();
    saver.edit(doc('Second'));
    saver.blur();
    expect(sent).toEqual([{ baseVersion: 3, description: doc('Second') }]);
    timers.advance(DESCRIPTION_IDLE_MS);
    expect(sent).toHaveLength(1);
  });

  it('saves only changed text: an unchanged blur or `Mod+Enter` sends nothing (D17)', () => {
    const { timers, sent, saver } = world();
    saver.blur();
    saver.saveNow();
    // Typed, then typed back to what was loaded.
    saver.edit(doc('Other'));
    saver.edit(doc('First'));
    timers.advance(DESCRIPTION_IDLE_MS);
    saver.blur();
    expect(sent).toEqual([]);
    expect(saver.getState().dirty).toBe(false);
  });

  it('keeps one save in flight; the next goes after the confirmation, from the confirmed version', async () => {
    const { sent, saver, answer, inFlight } = world();
    saver.edit(doc('Second'));
    saver.saveNow();
    saver.edit(doc('Third'));
    saver.saveNow();
    saver.edit(doc('Fourth'));
    saver.blur();
    expect(sent).toHaveLength(1);
    expect(saver.getState().saving).toBe(true);
    await answer({ kind: 'confirmed' });
    // One queued save, with the latest text, based on the version the first save made.
    expect(sent).toEqual([
      { baseVersion: 3, description: doc('Second') },
      { baseVersion: 4, description: doc('Fourth') },
    ]);
    expect(inFlight()).toBe(1);
    await answer({ kind: 'confirmed' });
    expect(saver.getState()).toMatchObject({ saving: false, dirty: false, conflict: false });
    expect(sent).toHaveLength(2);
  });

  it('sends no queued save when the text went back to what the first save confirmed', async () => {
    const { sent, saver, answer } = world();
    saver.edit(doc('Second'));
    saver.saveNow();
    saver.edit(doc('Third'));
    saver.saveNow();
    saver.edit(doc('Second'));
    await answer({ kind: 'confirmed' });
    expect(sent).toHaveLength(1);
  });

  it('saves text typed back to the old base during a save, after the idle time once confirmed', async () => {
    const { sent, saver, answer, timers } = world();
    saver.edit(doc('Second'));
    saver.saveNow();
    // Back to what was loaded: not unsaved against "First", so nothing is scheduled…
    saver.edit(doc('First'));
    expect(timers.pending.size).toBe(0);
    // …but it is against the confirmed "Second".
    await answer({ kind: 'confirmed' });
    expect(saver.getState().dirty).toBe(true);
    timers.advance(DESCRIPTION_IDLE_MS);
    expect(sent).toEqual([
      { baseVersion: 3, description: doc('Second') },
      { baseVersion: 4, description: doc('First') },
    ]);
  });
});

describe('a conflict (AC-12, D17)', () => {
  it('keeps the text, shows the banner and drops the queued save rather than sending it', async () => {
    const { sent, saver, answer, timers, inFlight } = world();
    saver.edit(doc('Mine'));
    saver.saveNow();
    saver.edit(doc('Mine, longer'));
    saver.saveNow();
    await answer({ kind: 'conflict' });
    expect(sent).toHaveLength(1);
    expect(inFlight()).toBe(0);
    expect(saver.getState()).toMatchObject({ conflict: true, doc: doc('Mine, longer') });
    // Nothing more is saved while the banner is up.
    saver.edit(doc('Mine, even longer'));
    timers.advance(DESCRIPTION_IDLE_MS);
    saver.blur();
    expect(sent).toHaveLength(1);
  });

  it('"Discard and reload" loads the replica’s description and version; saves continue from it', async () => {
    const { sent, saver, answer, remote } = world();
    // Not taken while the user has unsaved text… (E5)
    saver.edit(doc('Mine'));
    remote({ doc: doc('Theirs'), version: 4 });
    expect(saver.getState().doc).toEqual(doc('Mine'));
    saver.blur();
    await answer({ kind: 'conflict' });
    saver.discardAndReload();
    expect(saver.getState()).toMatchObject({ conflict: false, dirty: false, doc: doc('Theirs') });
    saver.edit(doc('Theirs, edited'));
    saver.blur();
    expect(sent.at(-1)).toEqual({ baseVersion: 4, description: doc('Theirs, edited') });
  });

  it('maps only the stale-base CONFLICT to the banner; other refusals are toasts and keep the text', async () => {
    expect(
      descriptionSendResult({
        status: 'rejected',
        error: { code: 'CONFLICT', message: DESCRIPTION_MESSAGES.stale },
      }),
    ).toEqual({ kind: 'conflict' });
    const deleted = 'ENG-42 was deleted. Restore it to edit it.';
    expect(
      descriptionSendResult({ status: 'rejected', error: { code: 'CONFLICT', message: deleted } }),
    ).toEqual({ kind: 'refused', message: deleted });
    expect(descriptionSendResult({ status: 'confirmed' })).toEqual({ kind: 'confirmed' });

    const { sent, saver, answer, refused } = world();
    saver.edit(doc('Mine'));
    saver.blur();
    await answer({ kind: 'refused', message: deleted });
    expect(refused).toEqual([deleted]);
    expect(saver.getState()).toMatchObject({ conflict: false, dirty: true, doc: doc('Mine') });
    // The next edit tries again, from the same base.
    saver.edit(doc('Mine!'));
    saver.blur();
    expect(sent.at(-1)).toEqual({ baseVersion: 3, description: doc('Mine!') });
  });

  it('treats a dispatch that throws (offline, never loaded) as a refusal', async () => {
    const refused: string[] = [];
    const initial = { doc: EMPTY_DOC, version: 1 };
    const saver = new DescriptionSaver(initial, {
      source: new FakeSource(initial, []),
      timers: new Timers(),
      send: () => Promise.reject(new Error('Available when online')),
      onRefused: (message) => refused.push(message),
    });
    saver.edit(doc('Offline text'));
    saver.blur();
    await Promise.resolve();
    await Promise.resolve();
    expect(refused).toEqual(['Available when online']);
    expect(saver.getState().doc).toEqual(doc('Offline text'));
  });
});

describe('a remote save (E5)', () => {
  it('keeps the user’s text when a remote save arrives while editing; the next save conflicts', async () => {
    const { sent, saver, answer, remote } = world();
    saver.edit(doc('Mine'));
    remote({ doc: doc('Theirs'), version: 4 });
    expect(saver.getState().doc).toEqual(doc('Mine'));
    saver.blur();
    // Sent from the version the user started from, so the server refuses it.
    expect(sent).toEqual([{ baseVersion: 3, description: doc('Mine') }]);
    await answer({ kind: 'conflict' });
    expect(saver.getState().conflict).toBe(true);
  });

  it('takes a remote save when nothing is unsaved, and saves from its version afterwards', () => {
    const { sent, saver, remote } = world();
    remote({ doc: doc('Theirs'), version: 4 });
    expect(saver.getState()).toMatchObject({ doc: doc('Theirs'), dirty: false });
    saver.edit(doc('Theirs, mine'));
    saver.blur();
    expect(sent).toEqual([{ baseVersion: 4, description: doc('Theirs, mine') }]);
  });

  it('follows a remote save that lands in the delta confirming its own save: no banner', async () => {
    const { saver, answer, source } = world();
    saver.edit(doc('Mine'));
    saver.blur();
    // Its own save is in the queue, and the saver doesn't count it against itself.
    expect(source.snapshot.changes).toEqual(['tab-1:1']);
    // One delta: this tab's save made v4, someone else's v5 on top.
    await answer({ kind: 'confirmed' }, { saved: { doc: doc('Theirs'), version: 5 } });
    expect(saver.getState()).toMatchObject({ doc: doc('Theirs'), dirty: false, conflict: false });
  });

  it('ignores an older replica version than the one its confirmed save made', async () => {
    const { saver, answer, remote } = world();
    saver.edit(doc('Mine'));
    saver.blur();
    await answer({ kind: 'confirmed' });
    remote({ doc: doc('First'), version: 3 });
    expect(saver.getState().doc).toEqual(doc('Mine'));
  });
});

describe('leaving the page', () => {
  it('saves on detach, and the sender then hears the page no longer shows refusals', async () => {
    const shownAtAnswer: boolean[] = [];
    let answer: (result: DescriptionSendResult) => void = () => undefined;
    const initial = { doc: doc('First'), version: 3 };
    const saver = new DescriptionSaver(initial, {
      source: new FakeSource(initial, []),
      timers: new Timers(),
      send: (_input, shown) =>
        new Promise((resolve) => {
          answer = (result) => {
            shownAtAnswer.push(shown());
            resolve(result);
          };
        }),
    });
    const detach = saver.attach();
    saver.edit(doc('Typed, then left'));
    detach();
    answer({ kind: 'confirmed' });
    await Promise.resolve();
    expect(shownAtAnswer).toEqual([false]);
  });

  it('leaves a refusal after the page closed to the shell: no second toast', async () => {
    const { saver, answer, refused, detach } = world();
    saver.edit(doc('Typed, then left'));
    detach();
    await answer({ kind: 'refused', message: 'ENG-42 was deleted. Restore it to edit it.' });
    expect(refused).toEqual([]);
  });

  it('still reports a save that never reached the store after the page closed', async () => {
    const refused: string[] = [];
    const initial = { doc: doc('First'), version: 3 };
    const saver = new DescriptionSaver(initial, {
      source: new FakeSource(initial, []),
      timers: new Timers(),
      send: () => Promise.reject(new Error("Couldn't save the description. Try again.")),
      onRefused: (message) => refused.push(message),
    });
    const detach = saver.attach();
    saver.edit(doc('Typed, then left'));
    detach();
    await Promise.resolve();
    await Promise.resolve();
    expect(refused).toEqual(["Couldn't save the description. Try again."]);
  });

  it('saves unsaved text on detach, arms no timer, and stops watching once nothing is held', () => {
    const { sent, saver, timers, source, detach } = world();
    saver.edit(doc('Leaving'));
    detach();
    expect(sent).toEqual([{ baseVersion: 3, description: doc('Leaving') }]);
    timers.advance(DESCRIPTION_IDLE_MS);
    expect(sent).toHaveLength(1);
    expect(timers.pending.size).toBe(0);
    // A save is in flight: still watching.
    expect(source.watchers).toBe(1);
  });

  it('stops watching at once when it closes with nothing to send (no leak)', () => {
    const { saver, source, detach } = world();
    expect(source.watchers).toBe(1);
    detach();
    expect(source.watchers).toBe(0);
    expect(saver.watching).toBe(false);
  });

  it('sends text queued behind an in-flight save after the page closed, then stops watching', async () => {
    const { sent, saver, answer, source, detach } = world();
    saver.edit(doc('Second'));
    saver.blur();
    saver.edit(doc('Third'));
    // Closed while "Second" is in flight: "Third" waits behind it.
    detach();
    expect(sent).toHaveLength(1);
    await answer({ kind: 'confirmed' });
    expect(sent).toEqual([
      { baseVersion: 3, description: doc('Second') },
      { baseVersion: 4, description: doc('Third') },
    ]);
    expect(source.watchers).toBe(1);
    await answer({ kind: 'confirmed' });
    expect(source.watchers).toBe(0);
  });

  it('sends text that waited for the issue’s create after the page closed, once it is confirmed', () => {
    // Opened on a pending issue: its create (another key) wrote the IssueContent at v1.
    const created = { doc: doc('From the composer'), version: 1 };
    const { sent, saver, source, remote, detach } = world(created, ['tab-1:900']);
    saver.edit(doc('From the composer, and more'));
    detach();
    expect(sent).toEqual([]);
    expect(source.watchers).toBe(1);
    // The create is confirmed: the server's row is the same text at v1.
    remote(created, []);
    expect(sent).toEqual([{ baseVersion: 1, description: doc('From the composer, and more') }]);
  });
});

describe('an earlier save still unconfirmed (SPEC-012 D31: never on a predicted version)', () => {
  // Opened while an earlier page's save of "Mine" on v5 is queued: the replica shows its predicted
  // v6, which the server may never make.
  const predicted = { doc: doc('Mine'), version: 6 };
  const earlier = ['tab-1:500'];

  it('sends nothing while it is unconfirmed, then saves on the confirmed version', () => {
    const { sent, saver, timers, remote } = world(predicted, earlier);
    saver.edit(doc('Mine, more'));
    timers.advance(DESCRIPTION_IDLE_MS);
    saver.blur();
    saver.saveNow();
    expect(sent).toEqual([]);
    expect(saver.getState().doc).toEqual(doc('Mine, more'));
    // Confirmed: the server made v6 with "Mine".
    remote({ doc: doc('Mine'), version: 6 }, []);
    expect(sent).toEqual([{ baseVersion: 6, description: doc('Mine, more') }]);
    expect(saver.getState().conflict).toBe(false);
  });

  it('shows the conflict and sends nothing when it was refused because someone saved first', () => {
    const { sent, saver, timers, remote } = world(predicted, earlier);
    saver.edit(doc('Mine, more'));
    saver.blur();
    // Refused (Bob had made v6): the overlay is gone and the replica shows Bob's text.
    remote({ doc: doc('Theirs'), version: 6 }, []);
    expect(saver.getState()).toMatchObject({
      conflict: true,
      conflictMessage: undefined,
      doc: doc('Mine, more'),
    });
    timers.advance(DESCRIPTION_IDLE_MS);
    saver.blur();
    expect(sent).toEqual([]);
    // Discard and reload takes the server's row, and saves continue from it.
    saver.discardAndReload();
    saver.edit(doc('Theirs, and mine'));
    saver.blur();
    expect(sent).toEqual([{ baseVersion: 6, description: doc('Theirs, and mine') }]);
  });

  it('gives the refusal’s own reason when the earlier save was refused for something else', () => {
    const { sent, saver, source } = world(predicted, earlier);
    saver.edit(doc('Mine, more'));
    saver.blur();
    const tooLong = 'Description is too long. Shorten it and try again.';
    source.set({
      saved: { doc: doc('First'), version: 5 },
      changes: [],
      refusals: [{ key: 'tab-1:500', message: tooLong }],
    });
    expect(saver.getState()).toMatchObject({ conflict: true, conflictMessage: tooLong });
    expect(sent).toEqual([]);
  });

  it('follows the server’s row with nothing unsaved, even when that save was overwritten after', () => {
    const { sent, saver, remote } = world(predicted, earlier);
    remote({ doc: doc('Theirs'), version: 7 }, []);
    expect(saver.getState()).toMatchObject({ conflict: false, dirty: false, doc: doc('Theirs') });
    expect(sent).toEqual([]);
  });

  it('shows the conflict when that save was confirmed but someone saved after it, with text typed', () => {
    const { sent, saver, remote } = world(predicted, earlier);
    saver.edit(doc('Mine, more'));
    remote({ doc: doc('Theirs'), version: 7 }, []);
    expect(saver.getState()).toMatchObject({ conflict: true, doc: doc('Mine, more') });
    expect(sent).toEqual([]);
  });

  it('never adopts a predicted row as its base: a save queued elsewhere after opening waits too', () => {
    // Opened on the confirmed v3; another save of this description is then queued (an earlier
    // page's save on close), and the replica shows its prediction.
    const { sent, saver, remote } = world();
    remote({ doc: doc('Queued'), version: 4 }, earlier);
    expect(saver.getState().doc).toEqual(doc('Queued'));
    saver.edit(doc('Queued, more'));
    saver.blur();
    expect(sent).toEqual([]);
    // Refused: the replica is back on the server's v3 "First"; the saver built on "Queued".
    remote({ doc: doc('First'), version: 3 }, []);
    expect(saver.getState().conflict).toBe(true);
    expect(sent).toEqual([]);
  });

  it('tells its own saves by their key, never by counting', async () => {
    const { sent, saver, answer, source } = world();
    saver.edit(doc('Second'));
    saver.blur();
    // An earlier save shows up in the queue beside this saver's own.
    source.set({ changes: [...source.snapshot.changes, ...earlier] });
    saver.edit(doc('Third'));
    saver.blur();
    await answer({ kind: 'confirmed' });
    // Its own is answered; the earlier one still blocks.
    expect(sent).toHaveLength(1);
    source.set({ changes: [] });
    expect(sent).toEqual([
      { baseVersion: 3, description: doc('Second') },
      { baseVersion: 4, description: doc('Third') },
    ]);
  });

  it('knows the queue’s saves and create of this issue only', () => {
    const issue = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
    const other = '0192f0c1-7e5a-7b3c-9d4e-0000000000b2';
    expect(changesDescription('issue.updateDescription', { issue, baseVersion: 1 }, issue)).toBe(
      true,
    );
    expect(changesDescription('issue.updateDescription', { issue: other }, issue)).toBe(false);
    expect(changesDescription('issue.create', { id: issue.toUpperCase(), title: 'x' }, issue)).toBe(
      true,
    );
    expect(changesDescription('issue.update', { issue, title: 'x' }, issue)).toBe(false);
    expect(changesDescription('issue.updateDescription', null, issue)).toBe(false);
  });
});
