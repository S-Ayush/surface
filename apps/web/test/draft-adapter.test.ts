// PLAN-012 S5 (SPEC-012 §3.2, §4.3): the draft adapter over a fake dispatcher and fake timers.
// AC-3 (save and discard, one composer draft per team, 30-day expiry, the 51st comment draft is
// the server's and the optimistic upsert's job: `operations/src/ops/draft.test.ts` and
// `server/test/draft-handlers.test.ts`), AC-21 and E19 (a draft saved offline is dispatched like
// any operation, so it queues), E13 (the replica's latest row wins), AC-24 (rejected comment text).
import type { DocNodeJSON } from '@surface/domain';
import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMENT_DRAFT_DEBOUNCE_MS,
  DraftAdapter,
  isEmptyDoc,
  type DraftRow,
} from '../src/features/issues/draft-adapter.js';

const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 24 * 60 * 60 * 1000;
const u = (n: number) => `0192f0c1-7e5a-7b3c-9d4e-${String(n).padStart(12, '0')}`;
const ENG = u(1);
const ISSUE = u(2);
const OTHER_ISSUE = u(3);

// Inferred, not `DocNodeJSON`: a row's `data` is JSON, and an interface has no index signature.
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const EMPTY: DocNodeJSON = { type: 'doc', content: [{ type: 'paragraph' }] };

let rowCounter = 100;
const row = (extra: Partial<DraftRow>): DraftRow => ({
  id: u((rowCounter += 1)),
  kind: 'comment',
  teamId: null,
  issueId: ISSUE,
  data: { text: doc('saved') },
  createdAt: new Date(NOW - DAY).toISOString(),
  updatedAt: new Date(NOW - DAY).toISOString(),
  ...extra,
});

function setup(initial: readonly DraftRow[] = [], connection: { throws?: string } = {}) {
  const rows = observable.box<readonly DraftRow[]>(initial, { deep: false });
  const sent: { op: string; input: Record<string, unknown> }[] = [];
  const failed: string[] = [];
  const adapter = new DraftAdapter({
    rows: () => rows.get(),
    dispatch: (op, input) => {
      if (connection.throws !== undefined) throw new Error(connection.throws);
      sent.push({ op: op.name, input: { ...input } });
      // Never settles: like a mutation queued while offline (AC-21, E19).
      return new Promise(() => undefined);
    },
    now: () => Date.now(),
    failed: (message) => failed.push(message),
  });
  return {
    adapter,
    sent,
    failed,
    setRows: (next: readonly DraftRow[]) => {
      runInAction(() => {
        rows.set(next);
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('composer drafts (AC-3)', () => {
  it('Save sends draft.save keyed by the team, with every field', () => {
    const { adapter, sent } = setup();
    adapter.saveComposer(ENG, {
      title: 'Plan',
      description: doc('Body'),
      statusId: null,
      priority: 2,
      assigneeId: null,
      labelIds: [],
      estimate: null,
      dueDate: null,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.op).toBe('draft.save');
    expect(sent[0]?.input).toMatchObject({
      kind: 'composer',
      teamId: ENG,
      data: { title: 'Plan', priority: 2, description: doc('Body') },
    });
    expect(typeof sent[0]?.input['id']).toBe('string');
  });

  it('finds the team’s one draft, and discarding sends draft.discard only when there is one', () => {
    const draft = row({ kind: 'composer', teamId: ENG, issueId: null, data: { title: 'x' } });
    const { adapter, sent, setRows } = setup([draft]);
    expect(adapter.composerDraft(ENG)).toBe(draft);
    adapter.discardComposer(ENG);
    expect(sent.map((s) => s.op)).toEqual(['draft.discard']);
    expect(sent[0]?.input).toEqual({ kind: 'composer', teamId: ENG });
    setRows([]);
    adapter.discardComposer(ENG);
    expect(sent).toHaveLength(1);
  });

  it('E13: the replica’s latest row is what the adapter reads (last write wins on the server)', () => {
    const first = row({ kind: 'composer', teamId: ENG, issueId: null, data: { title: 'Tab A' } });
    const { adapter, setRows } = setup([first]);
    setRows([{ ...first, data: { title: 'Tab B' }, updatedAt: new Date(NOW).toISOString() }]);
    expect(adapter.composerDraft(ENG)?.data).toEqual({ title: 'Tab B' });
  });

  it('a store that can’t take the change says why, and nothing is queued', () => {
    const { adapter, failed, sent } = setup([], { throws: 'Wait for the workspace to load.' });
    adapter.saveComposer(ENG, {
      title: 'x',
      description: null,
      statusId: null,
      priority: 0,
      assigneeId: null,
      labelIds: [],
      estimate: null,
      dueDate: null,
    });
    expect(failed).toEqual(['Wait for the workspace to load.']);
    expect(sent).toEqual([]);
  });
});

describe('comment drafts (§3.2)', () => {
  it('saves 500 ms after the last change, once, with the last text', () => {
    const { adapter, sent } = setup();
    adapter.setCommentText(ISSUE, doc('H'));
    vi.advanceTimersByTime(300);
    adapter.setCommentText(ISSUE, doc('He'));
    vi.advanceTimersByTime(300);
    adapter.setCommentText(ISSUE, doc('Hey'));
    expect(adapter.commentText(ISSUE)).toEqual(doc('Hey'));
    vi.advanceTimersByTime(COMMENT_DRAFT_DEBOUNCE_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toMatchObject({
      kind: 'comment',
      issueId: ISSUE,
      data: { text: doc('Hey') },
    });
  });

  it('keeps a timer per issue, and navigation (flush) saves what is waiting at once', () => {
    const { adapter, sent } = setup();
    adapter.setCommentText(ISSUE, doc('one'));
    adapter.setCommentText(OTHER_ISSUE, doc('two'));
    adapter.flush();
    expect(sent.map((s) => s.input['issueId'])).toEqual([ISSUE, OTHER_ISSUE]);
    vi.advanceTimersByTime(COMMENT_DRAFT_DEBOUNCE_MS);
    expect(sent).toHaveLength(2);
  });

  it('an emptied box deletes the saved draft; with none saved it sends nothing', () => {
    const { adapter, sent, setRows } = setup([row({})]);
    adapter.setCommentText(ISSUE, EMPTY);
    vi.advanceTimersByTime(COMMENT_DRAFT_DEBOUNCE_MS);
    expect(sent.map((s) => s.op)).toEqual(['draft.discard']);
    setRows([]);
    adapter.setCommentText(ISSUE, null);
    vi.advanceTimersByTime(COMMENT_DRAFT_DEBOUNCE_MS);
    expect(sent).toHaveLength(1);
  });

  it('shows the saved draft, and discards one older than 30 days when it is read', async () => {
    const fresh = row({ updatedAt: new Date(NOW - 29 * DAY).toISOString() });
    const old = row({
      issueId: OTHER_ISSUE,
      updatedAt: new Date(NOW - 31 * DAY).toISOString(),
    });
    const { adapter, sent } = setup([fresh, old]);
    expect(adapter.commentText(ISSUE)).toEqual(doc('saved'));
    expect(adapter.commentText(OTHER_ISSUE)).toBeUndefined();
    expect(adapter.commentText(OTHER_ISSUE)).toBeUndefined();
    // After the read, never during it (a render), and once however often it is read.
    expect(sent).toEqual([]);
    await Promise.resolve();
    expect(sent).toEqual([
      { op: 'draft.discard', input: { kind: 'comment', issueId: OTHER_ISSUE } },
    ]);
    expect(adapter.list().map((e) => e.row.id)).toEqual([fresh.id]);
  });

  it('sending the comment discards the draft and cancels a save still waiting', () => {
    const { adapter, sent } = setup();
    adapter.setCommentText(ISSUE, doc('Sent now'));
    adapter.discardComment(ISSUE);
    vi.advanceTimersByTime(COMMENT_DRAFT_DEBOUNCE_MS);
    expect(sent.map((s) => s.op)).toEqual(['draft.discard']);
  });

  it('AC-21, E19: offline, a save is dispatched like any operation and waits in the queue', () => {
    const { adapter, sent } = setup();
    adapter.setCommentText(ISSUE, doc('Typed offline'));
    vi.advanceTimersByTime(COMMENT_DRAFT_DEBOUNCE_MS);
    // The fake's promise never settles, as for a queued mutation; the adapter doesn't wait on it.
    expect(sent.map((s) => s.op)).toEqual(['draft.save']);
    expect(adapter.commentText(ISSUE)).toBeUndefined();
  });
});

describe('a rejected comment (§3.2, AC-24)', () => {
  it('goes back into the draft when the draft is empty or gone', () => {
    const { adapter, sent } = setup();
    expect(adapter.restoreRejectedComment(ISSUE, doc('Lost words'))).toBe('restored');
    expect(sent[0]).toMatchObject({
      op: 'draft.save',
      input: { kind: 'comment', issueId: ISSUE, data: { text: doc('Lost words') } },
    });
  });

  it('leaves a draft with new text alone, and the caller offers Copy text', () => {
    const { adapter, sent } = setup([row({ data: { text: doc('Newer') } })]);
    expect(adapter.restoreRejectedComment(ISSUE, doc('Lost words'))).toBe('copy');
    adapter.setCommentText(OTHER_ISSUE, doc('Typing'));
    expect(adapter.restoreRejectedComment(OTHER_ISSUE, doc('Lost'))).toBe('copy');
    expect(sent).toEqual([]);
  });
});

describe('the Drafts page list', () => {
  it('lists composer and comment drafts newest first; Delete draft discards by key', () => {
    const composer = row({
      kind: 'composer',
      teamId: ENG,
      issueId: null,
      data: { title: 'Plan' },
      updatedAt: new Date(NOW - 2 * DAY).toISOString(),
    });
    const comment = row({ updatedAt: new Date(NOW - DAY).toISOString() });
    const { adapter, sent } = setup([composer, comment]);
    const entries = adapter.list();
    expect(entries.map((e) => e.kind)).toEqual(['comment', 'composer']);
    for (const entry of entries) adapter.discard(entry);
    expect(sent.map((s) => s.input)).toEqual([
      { kind: 'comment', issueId: ISSUE },
      { kind: 'composer', teamId: ENG },
    ]);
  });

  it('an empty document is empty; text or any other block is not', () => {
    expect(isEmptyDoc(EMPTY)).toBe(true);
    expect(isEmptyDoc({ type: 'doc' })).toBe(true);
    expect(isEmptyDoc(doc('x'))).toBe(false);
    expect(isEmptyDoc({ type: 'doc', content: [{ type: 'horizontalRule' }] })).toBe(false);
  });
});
