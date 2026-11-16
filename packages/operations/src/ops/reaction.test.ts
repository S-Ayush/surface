// PLAN-013 S4, SPEC-013 §6.2: AC-11 (optimistic part: `reaction.set` inserts or removes the row
// with the id `reactionId(subject, user, emoji)` the server uses, for a comment and for the issue;
// no prediction where the server refuses), AC-13 (registry lint, contentParent, the `ui` entry;
// the examples run against the seed in the server's registry-contract test). Rows are parsed with
// the shared client model, as the client store does. That the predictions equal what the handler
// commits is checked in apps/server/test/reaction-set.test.ts ("optimistic equals the server").
import { isUuid, REACTION_EMOJI_LIMIT, reactionId } from '@surface/domain';
import { PRODUCTION_MODELS } from '@surface/domain/model';
import { describe, expect, it } from 'vitest';
import { lintOperations } from '../lint.js';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import { reactionSet } from './reaction.js';

const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const ME = '0192f0c1-7e5a-7b3c-9d4e-0000000000c1';
const IRIS = '0192f0c1-7e5a-7b3c-9d4e-0000000000c2';
const ISSUE = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const COMMENT = '0192f0c1-7e5a-7b3c-9d4e-000000000101';
const NOW = new Date('2026-11-16T10:00:00.000Z');

const MODELS = new Map<string, (typeof PRODUCTION_MODELS)[number]>(
  PRODUCTION_MODELS.map((m) => [m.name, m]),
);

type Store = OptimisticStore & { table(model: string): Map<string, StoreRow> };

/** The store over a live issue on TEAM, a comment by Iris on it, and me. */
function fakeStore(issue: Partial<StoreRow> = {}, comment: Partial<StoreRow> = {}): Store {
  const rows = new Map<string, Map<string, StoreRow>>();
  const table = (model: string) => {
    let t = rows.get(model);
    if (!t) rows.set(model, (t = new Map<string, StoreRow>()));
    return t;
  };
  const get = (model: string, ref: string): StoreRow | undefined => {
    if (model === 'User' && ref === 'me') return table(model).get(ME);
    return isUuid(ref) ? table(model).get(ref) : undefined;
  };
  const put = (model: string, row: StoreRow) => {
    const def = MODELS.get(model);
    if (!def) throw new Error(`unknown model ${model}`);
    // Parsed like the client store does: a predicted row must fit the model.
    const parsed: StoreRow = def.rowSchema.parse(row);
    const id = parsed['id'];
    if (typeof id !== 'string') throw new Error('row without id');
    table(model).set(id, parsed);
  };
  table('User').set(ME, { id: ME, role: 'member' });
  table('Issue').set(ISSUE, {
    id: ISSUE,
    teamId: TEAM,
    archivedAt: null,
    deletedAt: null,
    ...issue,
  });
  table('Comment').set(COMMENT, {
    id: COMMENT,
    issueId: ISSUE,
    teamId: TEAM,
    parentCommentId: null,
    userId: IRIS,
    deletedAt: null,
    ...comment,
  });
  return {
    table,
    now: NOW,
    get,
    insert: put,
    patch: () => {
      throw new Error('reaction.set never patches');
    },
    find: (model, fields) =>
      [...table(model).values()]
        .filter((row) => Object.entries(fields).every(([field, value]) => row[field] === value))
        .sort((a, b) => String(a['id']).localeCompare(String(b['id']))),
    archive: () => undefined,
    unarchive: () => undefined,
    remove: (model, ref) => void table(model).delete(ref),
  };
}

const reactions = (store: Store) => [...store.table('Reaction').values()];

describe('reaction.set optimistic (AC-11)', () => {
  it('inserts my reaction on a comment under the id the server derives', () => {
    const store = fakeStore();
    reactionSet.optimistic?.(store, { comment: COMMENT, emoji: '👍', reacted: true });
    expect(reactions(store)).toEqual([
      {
        id: reactionId(COMMENT, ME, '👍'),
        issueId: ISSUE,
        teamId: TEAM,
        commentId: COMMENT,
        userId: ME,
        emoji: '👍',
        createdAt: NOW.toISOString(),
      },
    ]);
  });

  it('inserts my reaction on the issue itself with no comment (AC-22)', () => {
    const store = fakeStore();
    reactionSet.optimistic?.(store, { issue: ISSUE, emoji: '🚀', reacted: true });
    expect(reactions(store)).toEqual([
      expect.objectContaining({
        id: reactionId(ISSUE, ME, '🚀'),
        issueId: ISSUE,
        commentId: null,
      }),
    ]);
  });

  it('removes my reaction, keeps others’, and repeats change nothing (E5)', () => {
    const store = fakeStore();
    reactionSet.optimistic?.(store, { comment: COMMENT, emoji: '🎉', reacted: true });
    reactionSet.optimistic?.(store, { comment: COMMENT, emoji: '🎉', reacted: true });
    expect(reactions(store)).toHaveLength(1);
    store.insert('Reaction', {
      id: reactionId(COMMENT, IRIS, '🎉'),
      issueId: ISSUE,
      teamId: TEAM,
      commentId: COMMENT,
      userId: IRIS,
      emoji: '🎉',
      createdAt: NOW.toISOString(),
    });
    reactionSet.optimistic?.(store, { comment: COMMENT, emoji: '🎉', reacted: false });
    reactionSet.optimistic?.(store, { comment: COMMENT, emoji: '🎉', reacted: false });
    expect(reactions(store).map((r) => r['userId'])).toEqual([IRIS]);
  });

  it('predicts nothing for a 21st distinct emoji (D15)', () => {
    const store = fakeStore();
    for (let i = 0; i < REACTION_EMOJI_LIMIT; i += 1) {
      const emoji = String.fromCodePoint(0x1f600 + i);
      store.insert('Reaction', {
        id: reactionId(ISSUE, IRIS, emoji),
        issueId: ISSUE,
        teamId: TEAM,
        commentId: null,
        userId: IRIS,
        emoji,
        createdAt: NOW.toISOString(),
      });
    }
    reactionSet.optimistic?.(store, { issue: ISSUE, emoji: '🚀', reacted: true });
    expect(reactions(store)).toHaveLength(REACTION_EMOJI_LIMIT);
    // The same emoji as one already there is allowed, and the comment's cap is its own.
    reactionSet.optimistic?.(store, { issue: ISSUE, emoji: '😀', reacted: true });
    reactionSet.optimistic?.(store, { comment: COMMENT, emoji: '🚀', reacted: true });
    expect(reactions(store)).toHaveLength(REACTION_EMOJI_LIMIT + 2);
  });

  it.each([
    ['an archived issue', { archivedAt: NOW.toISOString() }, {}],
    ['a deleted issue', { deletedAt: NOW.toISOString() }, {}],
    ['a deleted comment', {}, { deletedAt: NOW.toISOString() }],
  ])('predicts nothing on %s, which the server refuses', (_name, issue, comment) => {
    const store = fakeStore(issue, comment);
    reactionSet.optimistic?.(store, { comment: COMMENT, emoji: '👍', reacted: true });
    if (Object.keys(issue).length > 0) {
      reactionSet.optimistic?.(store, { issue: ISSUE, emoji: '👍', reacted: true });
    }
    expect(reactions(store)).toEqual([]);
  });
});

describe('registry rules (AC-13)', () => {
  it('pass the SPEC-003 §11 lint', () => {
    expect(lintOperations([reactionSet])).toEqual([]);
  });

  it('declare the content parent: the comment for its reaction, the issue for the issue’s', () => {
    expect(reactionSet.destructive).toBe(false);
    expect(reactionSet.contentParent?.({ comment: COMMENT, emoji: '👍', reacted: true })).toEqual({
      model: 'Comment',
      id: COMMENT,
    });
    expect(reactionSet.contentParent?.({ issue: 'ENG-1', emoji: '👍', reacted: true })).toEqual({
      model: 'Issue',
      id: 'ENG-1',
    });
  });

  it('offers "Add reaction…" on a focused comment and on an issue', () => {
    expect(reactionSet.ui).toMatchObject({
      title: 'Add reaction…',
      contexts: ['comment', 'issue'],
    });
  });
});
