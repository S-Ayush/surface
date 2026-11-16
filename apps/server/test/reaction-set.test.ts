// PLAN-013 S4, SPEC-013: AC-4 (`reaction.set` is idempotent, uses `reactionId`, takes one RGI
// emoji, caps distinct emoji at 20 per comment and per issue, takes exactly one of comment and
// issue, writes an event only on a change), AC-6 (archived and deleted issues, reaction half),
// AC-11 (the optimistic predicts the rows the server commits), AC-22 (issue reactions), E4, E5,
// E14, E25, `NOT_FOUND` on a deleted comment, and the lock order of §4.3. The rules run on the
// in-memory thread store (`support/memory-comments.ts`); the SQL is covered by the registry
// contract and the leak test.
import { randomUUID } from 'node:crypto';
import { REACTION_EMOJI_LIMIT, REACTION_MESSAGES, reactionId } from '@surface/domain';
import { reactionSet, type OptimisticStore } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import type { CommentRow } from '../src/handlers/comments/core.js';
import { setReaction, type SetReactionInput } from '../src/handlers/reactions/core.js';
import {
  ADA,
  IRIS,
  memoryComments,
  NOW,
  TEAM,
  type MemoryComments,
} from './support/memory-comments.js';
import { byId, clientRow, storeOver } from './support/memory-store.js';

async function failure(run: Promise<unknown>): Promise<SurfaceError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof SurfaceError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** The `CommentTarget` the executor builds from a resolved `CommentRef`. */
const onComment = (row: CommentRow): SetReactionInput['subject'] => ({
  kind: 'comment',
  target: { commentId: row.id, issueId: row.issueId, rootId: row.parentCommentId ?? row.id },
});
const onIssue = (m: MemoryComments): SetReactionInput['subject'] => ({
  kind: 'issue',
  issueId: m.issue.id,
});

function react(
  m: MemoryComments,
  subject: SetReactionInput['subject'],
  emoji: string,
  reacted = true,
  userId = ADA,
) {
  return setReaction(m.ctx({ userId }), { subject, emoji, reacted });
}

/** `count` distinct emoji, none of them 👍. */
const distinctEmoji = (count: number) =>
  Array.from({ length: count }, (_, i) => String.fromCodePoint(0x1f600 + i));

describe('reaction.set on a comment (AC-4)', () => {
  it('stores the reaction under its derived id, logs it, and emits reaction.added', async () => {
    const m = memoryComments();
    const root = m.addComment({});
    const result = await react(m, onComment(root), '👍');
    const id = reactionId(root.id, ADA, '👍');
    expect(result).toEqual({
      target: { type: 'comment', id: root.id },
      emoji: '👍',
      count: 1,
      mine: true,
    });
    expect(m.reactions.get(id)).toMatchObject({
      issueId: m.issue.id,
      teamId: TEAM,
      commentId: root.id,
      userId: ADA,
      emoji: '👍',
    });
    expect(m.writes).toEqual([{ action: 'I', model: 'Reaction', id, groups: [`team:${TEAM}`] }]);
    expect(m.events).toEqual([
      {
        type: 'reaction.added',
        subject: { type: 'reaction', id },
        data: { issueId: m.issue.id, commentId: root.id, emoji: '👍' },
      },
    ]);
  });

  it('changes nothing when the same user sets the same emoji again, from another tab (E5)', async () => {
    const m = memoryComments();
    const root = m.addComment({});
    await react(m, onComment(root), '👍');
    m.reset();
    const again = await react(m, onComment(root), '👍');
    expect(again).toMatchObject({ count: 1, mine: true });
    expect(m.writes).toEqual([]);
    expect(m.events).toEqual([]);
    expect(m.reactions.size).toBe(1);
  });

  it('keeps one row per person when two people set the same emoji (E4)', async () => {
    const m = memoryComments();
    const root = m.addComment({});
    await react(m, onComment(root), '🎉', true, IRIS);
    const mine = await react(m, onComment(root), '🎉');
    expect(mine).toMatchObject({ count: 2, mine: true });
    expect([...m.reactions.keys()].sort()).toEqual(
      [reactionId(root.id, IRIS, '🎉'), reactionId(root.id, ADA, '🎉')].sort(),
    );
  });

  it('clears only the caller’s reaction, with reaction.removed; clearing what isn’t set does nothing', async () => {
    const m = memoryComments();
    const root = m.addComment({});
    m.addReaction(root.id, IRIS, '🎉');
    const own = m.addReaction(root.id, ADA, '🎉');
    m.reset();
    const result = await react(m, onComment(root), '🎉', false);
    expect(result).toEqual({
      target: { type: 'comment', id: root.id },
      emoji: '🎉',
      count: 1,
      mine: false,
    });
    expect(m.writes).toEqual([
      { action: 'D', model: 'Reaction', id: own.id, groups: [`team:${TEAM}`] },
    ]);
    expect(m.events.map((e) => e.type)).toEqual(['reaction.removed']);
    m.reset();
    expect(await react(m, onComment(root), '🎉', false)).toMatchObject({ count: 1, mine: false });
    expect(m.writes).toEqual([]);
    expect(m.events).toEqual([]);
  });

  it.each([
    ['two emoji', '👍👍'],
    ['a letter', 'a'],
    ['an emoji with text', '👍 yes'],
    ['a regional indicator letter', '🇦'],
  ])('refuses %s with the §6.3 message, before any lock', async (_name, emoji) => {
    const m = memoryComments();
    const root = m.addComment({});
    const error = await failure(react(m, onComment(root), emoji));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe(REACTION_MESSAGES.notOneEmoji);
    expect(m.calls).toEqual([]);
  });

  it.each([
    ['a flag', '🏳️‍🌈'],
    ['a skin tone sequence', '👍🏽'],
    ['a keycap', '1️⃣'],
    ['a ZWJ family', '👨‍👩‍👧'],
  ])('accepts %s as one emoji', async (_name, emoji) => {
    const m = memoryComments();
    const root = m.addComment({});
    expect(await react(m, onComment(root), emoji)).toMatchObject({ emoji, count: 1 });
  });

  it('allows a 20th distinct emoji and refuses a 21st, once the thread lock is held (D15, E14)', async () => {
    const m = memoryComments();
    const root = m.addComment({});
    const nineteen = distinctEmoji(REACTION_EMOJI_LIMIT - 1);
    for (const emoji of nineteen) m.addReaction(root.id, IRIS, emoji);
    // Ada adds the 20th; Iris's 21st comes after it under the same lock, and is refused.
    await react(m, onComment(root), '👍');
    m.reset();
    const error = await failure(react(m, onComment(root), '🚀', true, IRIS));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('You can add at most 20 different reactions here.');
    expect(m.calls).toEqual(['lockIssue', `lockComment:${root.id}`, `reactionsOn:${root.id}`]);
    expect(m.writes).toEqual([]);
    // An emoji already there still counts up: Iris joins Ada's 👍.
    expect(await react(m, onComment(root), '👍', true, IRIS)).toMatchObject({ count: 2 });
  });

  it('locks the issue, then the thread root, then re-reads, for a reply too (§4.3)', async () => {
    const m = memoryComments();
    const root = m.addComment({});
    const reply = m.addComment({ parentCommentId: root.id, userId: IRIS });
    await react(m, onComment(reply), '👀');
    expect(m.calls).toEqual([
      'lockIssue',
      `lockComment:${root.id}`,
      `readComment:${reply.id}`,
      `reactionsOn:${reply.id}`,
    ]);
    expect(m.lockModes).toEqual(['edit']);
    expect(m.reactions.get(reactionId(reply.id, ADA, '👀'))?.commentId).toBe(reply.id);
  });

  it('is NOT_FOUND on a deleted comment (a placeholder) and on one deleted before the lock', async () => {
    const m = memoryComments();
    const root = m.addComment({ deletedAt: NOW });
    m.addComment({ parentCommentId: root.id, userId: IRIS });
    const placeholder = await failure(react(m, onComment(root), '👍'));
    expect(placeholder.code).toBe('NOT_FOUND');

    const gone = m.addComment({});
    m.comments.delete(gone.id);
    expect((await failure(react(m, onComment(gone), '👍'))).code).toBe('NOT_FOUND');
    expect(m.writes).toEqual([]);
  });
});

describe('reaction.set on the issue itself (AC-22, E25)', () => {
  it('uses reactionId(issueId, user, emoji) with no comment, under the issue lock only', async () => {
    const m = memoryComments();
    const result = await react(m, onIssue(m), '🚀');
    const id = reactionId(m.issue.id, ADA, '🚀');
    expect(result).toEqual({
      target: { type: 'issue', id: m.issue.id },
      emoji: '🚀',
      count: 1,
      mine: true,
    });
    expect(m.reactions.get(id)).toMatchObject({ issueId: m.issue.id, commentId: null });
    expect(m.calls).toEqual(['lockIssue', `reactionsOn:${m.issue.id}`]);
    expect(m.lockModes).toEqual(['edit']);
  });

  it('has its own cap of 20, apart from its comments’', async () => {
    const m = memoryComments();
    const root = m.addComment({});
    for (const emoji of distinctEmoji(REACTION_EMOJI_LIMIT)) {
      m.addReaction(root.id, IRIS, emoji);
    }
    // The comment is full; the issue is not.
    expect(await react(m, onIssue(m), '👍')).toMatchObject({ count: 1 });
    for (const emoji of distinctEmoji(REACTION_EMOJI_LIMIT - 1)) {
      m.addReaction(null, IRIS, emoji);
    }
    const error = await failure(react(m, onIssue(m), '🚀'));
    expect(error.message).toBe(REACTION_MESSAGES.tooMany);
    // A comment reaction on the same emoji is a separate row: the issue's 👍 doesn't count for it.
    expect((await failure(react(m, onComment(root), '👍'))).message).toBe(
      REACTION_MESSAGES.tooMany,
    );
  });

  it('keeps an issue reaction and a comment reaction with the same emoji apart', async () => {
    const m = memoryComments();
    const root = m.addComment({});
    await react(m, onIssue(m), '👍');
    await react(m, onComment(root), '👍');
    expect(m.reactions.size).toBe(2);
    expect(await react(m, onIssue(m), '👍', false)).toMatchObject({ count: 0, mine: false });
    expect([...m.reactions.values()].map((r) => r.commentId)).toEqual([root.id]);
  });
});

describe('archived and deleted issues (AC-6, E15, E17)', () => {
  it.each([
    ['archived', 'ENG-42 is archived. Restore it to edit it.'],
    ['deleted', 'ENG-42 was deleted. Restore it to edit it.'],
  ] as const)(
    'a reaction on a %s issue or its comment is CONFLICT, and nothing is written',
    async (state, message) => {
      const m = memoryComments();
      const root = m.addComment({});
      m.addReaction(root.id, ADA, '👍');
      m.addReaction(null, ADA, '🎉');
      if (state === 'archived') m.issue.archivedAt = NOW;
      else m.issue.deletedAt = NOW;
      m.reset();
      for (const [subject, emoji, reacted] of [
        [onComment(root), '🚀', true],
        [onComment(root), '👍', false],
        [onIssue(m), '🚀', true],
        [onIssue(m), '🎉', false],
      ] as const) {
        const error = await failure(react(m, subject, emoji, reacted));
        expect(error.code).toBe('CONFLICT');
        expect(error.message).toBe(message);
      }
      expect(m.writes).toEqual([]);
      expect(m.events).toEqual([]);
      // Nothing unarchives or restores the issue.
      expect(state === 'archived' ? m.issue.archivedAt : m.issue.deletedAt).toBe(NOW);
    },
  );
});

describe('the input (AC-4, §6.3)', () => {
  const parse = (input: object) => reactionSet.input.safeParse(input);

  it('takes exactly one of comment and issue', () => {
    const comment = randomUUID();
    for (const input of [
      { comment, issue: 'ENG-1', emoji: '👍', reacted: true },
      { emoji: '👍', reacted: true },
    ]) {
      const result = parse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.message)).toEqual([REACTION_MESSAGES.subject]);
    }
    expect(parse({ comment, emoji: '👍', reacted: true }).success).toBe(true);
    expect(parse({ issue: 'ENG-1', emoji: '👍', reacted: false }).success).toBe(true);
  });

  it('needs an emoji and a reacted boolean', () => {
    expect(parse({ issue: 'ENG-1', emoji: '', reacted: true }).success).toBe(false);
    expect(parse({ issue: 'ENG-1', emoji: '👍' }).success).toBe(false);
  });
});

describe('AC-11: optimistic equals the server', () => {
  /** A thread by Ada with Iris's 👍 on the root and Iris's 🎉 on the issue. */
  function thread() {
    const m = memoryComments();
    const root = m.addComment({});
    m.addReaction(root.id, IRIS, '👍');
    m.addReaction(null, IRIS, '🎉');
    return { m, root };
  }
  type Thread = ReturnType<typeof thread>;

  const cases: [string, (t: Thread) => SetReactionInput & { input: object }][] = [
    [
      'set on a comment',
      ({ root }) => ({
        subject: onComment(root),
        emoji: '👍',
        reacted: true,
        input: { comment: root.id },
      }),
    ],
    [
      'set on the issue',
      ({ m }) => ({
        subject: onIssue(m),
        emoji: '🎉',
        reacted: true,
        input: { issue: m.issue.id },
      }),
    ],
    [
      'clear on a comment, after setting it',
      ({ root }) => ({
        subject: onComment(root),
        emoji: '👀',
        reacted: false,
        input: { comment: root.id },
      }),
    ],
    [
      'set what is already set',
      ({ m }) => ({
        subject: onIssue(m),
        emoji: '🚀',
        reacted: true,
        input: { issue: m.issue.id },
      }),
    ],
  ];

  it.each(cases)('%s predicts the rows the server commits', async (_name, make) => {
    const t = thread();
    const call = make(t);
    // Ada's own reactions the clearing and repeating cases act on.
    await setReaction(t.m.ctx(), { subject: call.subject, emoji: '👀', reacted: true });
    await setReaction(t.m.ctx(), { subject: onIssue(t.m), emoji: '🚀', reacted: true });
    const store: OptimisticStore & { rows(model: string): unknown[] } = storeOver(t.m);
    reactionSet.optimistic?.(store, { ...call.input, emoji: call.emoji, reacted: call.reacted });
    await setReaction(t.m.ctx(), call);
    expect(store.rows('Reaction')).toEqual(byId([...t.m.reactions.values()].map(clientRow)));
  });

  it('predicts nothing for the 21st distinct emoji, which the server refuses', async () => {
    const t = thread();
    for (const emoji of distinctEmoji(REACTION_EMOJI_LIMIT - 1)) t.m.addReaction(null, IRIS, emoji);
    const store = storeOver(t.m);
    reactionSet.optimistic?.(store, { issue: t.m.issue.id, emoji: '🚀', reacted: true });
    await failure(setReaction(t.m.ctx(), { subject: onIssue(t.m), emoji: '🚀', reacted: true }));
    expect(store.rows('Reaction')).toEqual(byId([...t.m.reactions.values()].map(clientRow)));
  });

  it('predicts nothing on an archived issue or a deleted comment', () => {
    const t = thread();
    t.m.issue.archivedAt = NOW;
    const archived = storeOver(t.m);
    reactionSet.optimistic?.(archived, { issue: t.m.issue.id, emoji: '🚀', reacted: true });
    reactionSet.optimistic?.(archived, { comment: t.root.id, emoji: '🚀', reacted: true });
    t.m.issue.archivedAt = null;
    const placeholder = t.m.addComment({ deletedAt: NOW });
    const live = storeOver(t.m);
    reactionSet.optimistic?.(live, { comment: placeholder.id, emoji: '🚀', reacted: true });
    for (const store of [archived, live]) {
      expect(store.rows('Reaction')).toEqual(byId([...t.m.reactions.values()].map(clientRow)));
    }
  });
});
