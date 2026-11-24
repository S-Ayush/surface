// PLAN-015 S4 (SPEC-015 §3.1 item 4, §3.3 item 7, E14, E24): the one restore flow behind `#`, the
// row and page menus, "Restore issue" in `Mod+K` and `Mod+Z`. "Restoring ENG-42…" until the
// mutation is confirmed, then "Restored ENG-42" with **Open**; never a packet.
import { overlayManager } from '@surface/ui';
import { observable, onBecomeObserved, onBecomeUnobserved, runInAction } from 'mobx';
import { afterEach, describe, expect, it } from 'vitest';
import { LifecycleEvents, type LifecycleEvent } from '../src/features/archive/lifecycle-events.js';
import { restoreIssue } from '../src/features/archive/restore-flow.js';
import { announcer } from '../src/features/issues/announcer.js';
import type { MutationStore } from '../src/features/teams/submit.js';

type Outcome =
  { status: 'confirmed' } | { status: 'rejected'; error: { code: string; message: string } };

function fakeStore(connection = 'online') {
  const answers: ((outcome: Outcome) => void)[] = [];
  const sent: unknown[] = [];
  // Observable, like the store's: the flow watches it while it waits.
  const box = observable.box(connection);
  const store: MutationStore = {
    get connection() {
      return box.get();
    },
    dispatch: (op, input) =>
      new Promise((resolve) => {
        sent.push([op.name, input]);
        answers.push(resolve);
      }),
  };
  const setConnection = (next: string) => {
    runInAction(() => {
      box.set(next);
    });
  };
  return { store, answers, sent, setConnection };
}

function recordEvents() {
  const events = new LifecycleEvents();
  const seen: LifecycleEvent[] = [];
  events.subscribe((event) => seen.push(event));
  return { events, seen };
}

const visible = () => overlayManager.getSnapshot().visibleToasts;
const ISSUE = { id: 'i1', identifier: 'ENG-42' };

afterEach(() => {
  overlayManager.clear();
});

describe('restoreIssue', () => {
  it('says "Restoring ENG-42…" until confirmed, then "Restored ENG-42" with Open', async () => {
    const { store, answers, sent } = fakeStore();
    const opened: string[] = [];
    const { events, seen } = recordEvents();
    const done = restoreIssue(store, ISSUE, {
      events,
      open: (issue) => opened.push(issue.identifier),
    });
    expect(sent).toEqual([['issue.restore', { issue: 'i1' }]]);
    expect(visible().map((t) => t.message)).toEqual(['Restoring ENG-42…']);
    expect(seen).toEqual([{ kind: 'restoring', issueId: 'i1' }]);
    answers[0]?.({ status: 'confirmed' });
    expect(await done).toBe('confirmed');
    const [toast] = visible();
    expect(toast?.message).toBe('Restored ENG-42');
    expect(toast?.action?.label).toBe('Open');
    toast?.action?.onAction();
    expect(opened).toEqual(['ENG-42']);
    expect(announcer.snapshot().text).toBe('Restored ENG-42');
    expect(seen.at(-1)).toEqual({ kind: 'confirmed', op: 'restore', issueId: 'i1' });
  });

  it('offline, says when it will finish and still finishes on the confirmation (E14)', async () => {
    const { store, answers } = fakeStore('offline');
    const { events } = recordEvents();
    expect(await restoreIssue(store, ISSUE, { events })).toBe('queued');
    expect(visible().map((t) => t.message)).toEqual([
      "ENG-42 will be restored when you're back online.",
    ]);
    answers[0]?.({ status: 'confirmed' });
    await Promise.resolve();
    await Promise.resolve();
    expect(visible().map((t) => t.message)).toEqual(['Restored ENG-42']);
  });

  it('says it is queued when the connection drops while waiting, then still says "Restored" (E14)', async () => {
    const { store, answers, setConnection } = fakeStore();
    const { events, seen } = recordEvents();
    const done = restoreIssue(store, ISSUE, { events });
    expect(visible().map((t) => t.message)).toEqual(['Restoring ENG-42…']);
    setConnection('offline');
    expect(await done).toBe('queued');
    expect(visible().map((t) => t.message)).toEqual([
      "ENG-42 will be restored when you're back online.",
    ]);
    setConnection('online');
    answers[0]?.({ status: 'confirmed' });
    await Promise.resolve();
    await Promise.resolve();
    expect(visible().map((t) => t.message)).toEqual(['Restored ENG-42']);
    expect(seen.at(-1)).toEqual({ kind: 'confirmed', op: 'restore', issueId: 'i1' });
  });

  it('stops watching the connection once the answer arrives', async () => {
    const { store, answers } = fakeStore();
    const box = observable.box('online');
    let watched = false;
    const watching: MutationStore = {
      get connection() {
        return box.get();
      },
      dispatch: (op, input) => store.dispatch(op, input),
    };
    onBecomeObserved(box, () => {
      watched = true;
    });
    onBecomeUnobserved(box, () => {
      watched = false;
    });
    const done = restoreIssue(watching, ISSUE, { events: recordEvents().events });
    expect(watched).toBe(true);
    answers[0]?.({ status: 'confirmed' });
    expect(await done).toBe('confirmed');
    expect(watched).toBe(false);
    // A later drop changes nothing.
    runInAction(() => {
      box.set('offline');
    });
    expect(visible().map((t) => t.message)).toEqual(['Restored ENG-42']);
  });

  it('a refusal stops saying "Restoring" and tells the list to bring the row back (E24)', async () => {
    const { store, answers } = fakeStore();
    const { events, seen } = recordEvents();
    const done = restoreIssue(store, ISSUE, { events });
    answers[0]?.({
      status: 'rejected',
      error: {
        code: 'CONFLICT',
        message: "ENG-42 was deleted more than 30 days ago and can't be restored.",
      },
    });
    expect(await done).toBe('refused');
    expect(visible()).toEqual([]);
    expect(seen.at(-1)).toEqual({ kind: 'refused', op: 'restore', issueId: 'i1' });
  });

  it("says what went wrong when the store doesn't take the restore", async () => {
    const store: MutationStore = {
      connection: 'online',
      dispatch: () => {
        throw new Error('Sign in again to keep working.');
      },
    };
    const { events, seen } = recordEvents();
    expect(await restoreIssue(store, ISSUE, { events })).toBe('refused');
    expect(visible().map((t) => [t.tone, t.message])).toEqual([
      ['danger', 'Sign in again to keep working.'],
    ]);
    expect(seen).toEqual([{ kind: 'refused', op: 'restore', issueId: 'i1' }]);
  });
});
