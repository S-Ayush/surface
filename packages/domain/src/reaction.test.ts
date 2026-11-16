// PLAN-013 S4, SPEC-013 §4.2, §6.1, D15: the reaction chips both outputs show, and the 20-emoji cap.
import { describe, expect, it } from 'vitest';
import { reactionId } from './doc.js';
import {
  REACTION_EMOJI_LIMIT,
  REACTION_MESSAGES,
  reactionCapProblem,
  summariseReactions,
} from './reaction.js';

const ADA = '0192f0c1-7e5a-7b3c-9d4e-0000000000ad';
const IRIS = '0192f0c1-7e5a-7b3c-9d4e-00000000001e';
const SAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000a5';
const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute));

describe('summariseReactions', () => {
  it('gives one chip per emoji with its count, and mine when the viewer set it', () => {
    const rows = [
      { userId: ADA, emoji: '👍', createdAt: at(1) },
      { userId: IRIS, emoji: '👍', createdAt: at(2) },
      { userId: IRIS, emoji: '🎉', createdAt: at(3) },
    ];
    expect(summariseReactions(rows, ADA)).toEqual([
      { emoji: '👍', count: 2, mine: true },
      { emoji: '🎉', count: 1, mine: false },
    ]);
    expect(summariseReactions(rows, SAM).map((r) => r.mine)).toEqual([false, false]);
    expect(summariseReactions(rows, null).map((r) => r.mine)).toEqual([false, false]);
  });

  it('orders chips by when the emoji was first set, whatever order the rows come in', () => {
    const rows = [
      { userId: ADA, emoji: '🎉', createdAt: at(5) },
      { userId: IRIS, emoji: '👀', createdAt: at(4) },
      { userId: SAM, emoji: '🎉', createdAt: at(1) },
    ];
    expect(summariseReactions(rows, ADA).map((r) => r.emoji)).toEqual(['🎉', '👀']);
  });

  it('reads ISO strings (the client replica) the same as dates (the server)', () => {
    const server = [
      { userId: ADA, emoji: '🚀', createdAt: at(2) },
      { userId: IRIS, emoji: '❤️', createdAt: at(1) },
    ];
    const client = server.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    expect(summariseReactions(client, IRIS)).toEqual(summariseReactions(server, IRIS));
  });

  it('breaks ties by emoji, so two sides agree on the order', () => {
    const rows = [
      { userId: ADA, emoji: '🙂', createdAt: at(1) },
      { userId: ADA, emoji: '😀', createdAt: at(1) },
    ];
    expect(summariseReactions(rows, ADA).map((r) => r.emoji)).toEqual(['😀', '🙂']);
    expect(summariseReactions([], ADA)).toEqual([]);
  });
});

describe('reactionCapProblem (D15, E14, E25)', () => {
  const distinct = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ emoji: String.fromCodePoint(0x1f600 + i) }));

  it('allows a 20th distinct emoji and refuses a 21st with the §6.3 message', () => {
    expect(REACTION_EMOJI_LIMIT).toBe(20);
    expect(reactionCapProblem(distinct(19), '🚀')).toBeUndefined();
    expect(reactionCapProblem(distinct(20), '🚀')).toBe(REACTION_MESSAGES.tooMany);
    expect(REACTION_MESSAGES.tooMany).toBe('You can add at most 20 different reactions here.');
  });

  it('always allows an emoji the subject already carries', () => {
    const full = distinct(20);
    expect(reactionCapProblem([...full, ...full], full[0]?.emoji ?? '')).toBeUndefined();
  });

  it('keys reactions by subject, user and emoji', () => {
    const subject = '0192f0c1-7e5a-7b3c-9d4e-0000000000c1';
    expect(reactionId(subject, ADA, '👍')).not.toBe(reactionId(subject, IRIS, '👍'));
  });
});
