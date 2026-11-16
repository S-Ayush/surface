// SPEC-012 §3.4 item 3, AC-12, E5; SPEC-011 D17; PLAN-012 S4b: the description's save controller
// with a fake dispatcher and fake timers. Saves after 2 s idle or on blur with the `baseVersion`
// it was loaded from; one save in flight; a queued save is dropped on CONFLICT, never sent; only
// changed text is saved; "Discard and reload" takes the replica's version.
import { DESCRIPTION_MESSAGES, EMPTY_DOC, type DocNodeJSON } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_IDLE_MS,
  DescriptionSaver,
  descriptionSendResult,
  type DescriptionSendResult,
  unconfirmedDescriptionChanges,
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

/** A dispatcher the test answers by hand, recording what was sent. */
function world(initial = { doc: doc('First'), version: 3 }, unconfirmed = 0) {
  const timers = new Timers();
  const sent: { baseVersion: number; description: DocNodeJSON }[] = [];
  const answers: ((result: DescriptionSendResult) => void)[] = [];
  const refused: string[] = [];
  const saver = new DescriptionSaver(
    initial,
    {
      timers,
      send: (input) => {
        sent.push(input);
        return new Promise((resolve) => answers.push(resolve));
      },
      onRefused: (message) => refused.push(message),
    },
    unconfirmed,
  );
  /** Answers the oldest unanswered save, then lets the controller's continuation run. */
  const answer = async (result: DescriptionSendResult) => {
    const next = answers.shift();
    if (next === undefined) throw new Error('nothing in flight');
    next(result);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { timers, sent, saver, answer, refused, inFlight: () => answers.length };
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
    const { sent, saver, answer } = world();
    saver.remote({ doc: doc('Theirs'), version: 4 });
    // Not taken while the user has unsaved text… (E5)
    saver.edit(doc('Mine'));
    saver.remote({ doc: doc('Theirs'), version: 4 });
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
    saver.attach();
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
    const saver = new DescriptionSaver(
      { doc: EMPTY_DOC, version: 1 },
      {
        timers: new Timers(),
        send: () => Promise.reject(new Error('Available when online')),
        onRefused: (message) => refused.push(message),
      },
    );
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
    const { sent, saver, answer } = world();
    saver.edit(doc('Mine'));
    saver.remote({ doc: doc('Theirs'), version: 4 });
    expect(saver.getState().doc).toEqual(doc('Mine'));
    saver.blur();
    // Sent from the version the user started from, so the server refuses it.
    expect(sent).toEqual([{ baseVersion: 3, description: doc('Mine') }]);
    await answer({ kind: 'conflict' });
    expect(saver.getState().conflict).toBe(true);
  });

  it('takes a remote save when nothing is unsaved, and saves from its version afterwards', () => {
    const { sent, saver } = world();
    saver.remote({ doc: doc('Theirs'), version: 4 });
    expect(saver.getState()).toMatchObject({ doc: doc('Theirs'), dirty: false });
    saver.edit(doc('Theirs, mine'));
    saver.blur();
    expect(sent).toEqual([{ baseVersion: 4, description: doc('Theirs, mine') }]);
  });

  it('follows a remote save that landed while its own save was in flight, once it is confirmed', async () => {
    const { saver, answer } = world();
    saver.edit(doc('Mine'));
    saver.blur();
    // This tab's save made version 4; someone else's then made 5.
    saver.remote({ doc: doc('Theirs'), version: 5 });
    expect(saver.getState().doc).toEqual(doc('Mine'));
    await answer({ kind: 'confirmed' });
    expect(saver.getState()).toMatchObject({ doc: doc('Theirs'), dirty: false });
  });

  it('ignores an older replica version than the one its confirmed save made', async () => {
    const { saver, answer } = world();
    saver.edit(doc('Mine'));
    saver.blur();
    await answer({ kind: 'confirmed' });
    saver.remote({ doc: doc('First'), version: 3 });
    expect(saver.getState().doc).toEqual(doc('Mine'));
  });
});

describe('leaving the page', () => {
  it('saves on detach, and the sender then hears the page no longer shows refusals', async () => {
    const shownAtAnswer: boolean[] = [];
    let answer: (result: DescriptionSendResult) => void = () => undefined;
    const saver = new DescriptionSaver(
      { doc: doc('First'), version: 3 },
      {
        timers: new Timers(),
        send: (_input, shown) =>
          new Promise((resolve) => {
            answer = (result) => {
              shownAtAnswer.push(shown());
              resolve(result);
            };
          }),
      },
    );
    const detach = saver.attach();
    saver.edit(doc('Typed, then left'));
    detach();
    answer({ kind: 'confirmed' });
    await Promise.resolve();
    expect(shownAtAnswer).toEqual([false]);
  });

  it('leaves a refusal after the page closed to the shell: no second toast', async () => {
    const { saver, answer, refused } = world();
    const detach = saver.attach();
    saver.edit(doc('Typed, then left'));
    detach();
    await answer({ kind: 'refused', message: 'ENG-42 was deleted. Restore it to edit it.' });
    expect(refused).toEqual([]);
  });

  it('still reports a save that never reached the store after the page closed', async () => {
    const refused: string[] = [];
    const saver = new DescriptionSaver(
      { doc: doc('First'), version: 3 },
      {
        timers: new Timers(),
        send: () => Promise.reject(new Error("Couldn't save the description. Try again.")),
        onRefused: (message) => refused.push(message),
      },
    );
    const detach = saver.attach();
    saver.edit(doc('Typed, then left'));
    detach();
    await Promise.resolve();
    await Promise.resolve();
    expect(refused).toEqual(["Couldn't save the description. Try again."]);
  });

  it('saves unsaved text when disposed, and sends nothing more after the timer', () => {
    const { sent, saver, timers } = world();
    saver.edit(doc('Leaving'));
    saver.dispose();
    expect(sent).toEqual([{ baseVersion: 3, description: doc('Leaving') }]);
    timers.advance(DESCRIPTION_IDLE_MS);
    expect(sent).toHaveLength(1);
    expect(timers.pending.size).toBe(0);
  });
});

describe('after a confirmation', () => {
  it('saves text typed back to the old base during the save, after the idle time', async () => {
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

describe('an earlier save still unconfirmed (SPEC-012 D31: never on a predicted version)', () => {
  // Opened while an earlier page's save of "Mine" on v5 is queued: the replica shows its predicted
  // v6, which the server may never make.
  const predicted = { doc: doc('Mine'), version: 6 };

  it('sends nothing while it is unconfirmed, then saves on the confirmed version', () => {
    const { sent, saver, timers } = world(predicted, 1);
    saver.edit(doc('Mine, more'));
    timers.advance(DESCRIPTION_IDLE_MS);
    saver.blur();
    saver.saveNow();
    expect(sent).toEqual([]);
    expect(saver.getState().doc).toEqual(doc('Mine, more'));
    // Confirmed: the server made v6 with "Mine".
    saver.remote({ doc: doc('Mine'), version: 6 }, 0);
    expect(sent).toEqual([{ baseVersion: 6, description: doc('Mine, more') }]);
    expect(saver.getState().conflict).toBe(false);
  });

  it('shows the conflict and sends nothing when it was refused because someone saved first', () => {
    const { sent, saver, timers } = world(predicted, 1);
    saver.edit(doc('Mine, more'));
    saver.blur();
    // Refused (Bob had made v6): the overlay is gone and the replica shows Bob's text.
    saver.remote({ doc: doc('Theirs'), version: 6 }, 0);
    expect(saver.getState()).toMatchObject({ conflict: true, doc: doc('Mine, more') });
    timers.advance(DESCRIPTION_IDLE_MS);
    saver.blur();
    expect(sent).toEqual([]);
    // Discard and reload takes the server's row, and saves continue from it.
    saver.discardAndReload();
    saver.edit(doc('Theirs, and mine'));
    saver.blur();
    expect(sent).toEqual([{ baseVersion: 6, description: doc('Theirs, and mine') }]);
  });

  it('shows the conflict when that save was confirmed but someone saved after it', () => {
    const { sent, saver } = world(predicted, 1);
    saver.remote({ doc: doc('Theirs'), version: 7 }, 0);
    expect(saver.getState()).toMatchObject({ conflict: true, doc: doc('Mine') });
    expect(sent).toEqual([]);
  });

  it('never adopts a predicted row as its base: a save queued elsewhere after opening waits too', () => {
    // Opened on the confirmed v3; another save of this description is then queued (an earlier
    // page's save on close), and the replica shows its prediction.
    const { sent, saver } = world();
    saver.remote({ doc: doc('Queued'), version: 4 }, 1);
    expect(saver.getState().doc).toEqual(doc('Queued'));
    saver.edit(doc('Queued, more'));
    saver.blur();
    expect(sent).toEqual([]);
    // Refused: the replica is back on the server's v3 "First"; the saver built on "Queued".
    saver.remote({ doc: doc('First'), version: 3 }, 0);
    expect(saver.getState().conflict).toBe(true);
    expect(sent).toEqual([]);
  });

  it('counts its own save once: with only that one unconfirmed, the next save is queued, not blocked', async () => {
    const { sent, saver, answer } = world();
    saver.edit(doc('Second'));
    saver.blur();
    // The store now holds this saver's own save.
    saver.remote({ doc: doc('Second'), version: 4 }, 1);
    saver.edit(doc('Third'));
    saver.blur();
    await answer({ kind: 'confirmed' });
    saver.remote({ doc: doc('Second'), version: 4 }, 0);
    expect(sent).toEqual([
      { baseVersion: 3, description: doc('Second') },
      { baseVersion: 4, description: doc('Third') },
    ]);
  });

  it('counts the queue’s saves and create of this issue only', () => {
    const issue = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
    const other = '0192f0c1-7e5a-7b3c-9d4e-0000000000b2';
    expect(
      unconfirmedDescriptionChanges(
        [
          { op: 'issue.updateDescription', input: { issue, baseVersion: 1 } },
          { op: 'issue.updateDescription', input: { issue: other, baseVersion: 1 } },
          { op: 'issue.create', input: { id: issue.toUpperCase(), title: 'x' } },
          { op: 'issue.update', input: { issue, title: 'x' } },
          { op: 'issue.updateDescription', input: null },
        ],
        issue,
      ),
    ).toBe(2);
  });
});
