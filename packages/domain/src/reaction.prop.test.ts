// PLAN-013 S4, SPEC-013 §4.2, §6.1: reaction ids and chips, as properties. The id is unique per
// (subject, user, emoji); the chips count every row once, in an order that doesn't depend on the
// order rows arrive in, and `mine` is exactly "the viewer has a row with that emoji".
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { reactionId } from './doc.js';
import { summariseReactions } from './reaction.js';

const EMOJI = ['👍', '🎉', '👀', '❤️', '🚀', '👍🏽', '🏳️‍🌈', '1️⃣'] as const;
const USERS = ['u1', 'u2', 'u3', 'u4'] as const;

const row = fc.record({
  userId: fc.constantFrom(...USERS),
  emoji: fc.constantFrom(...EMOJI),
  createdAt: fc.date({
    min: new Date('2026-01-01T00:00:00Z'),
    max: new Date('2026-12-31T00:00:00Z'),
    noInvalidDate: true,
  }),
});

describe('reactionId (properties)', () => {
  it('differs whenever the subject, the user or the emoji differs', () => {
    const triple = fc.tuple(fc.uuid(), fc.uuid(), fc.constantFrom(...EMOJI));
    fc.assert(
      fc.property(triple, triple, (a, b) => {
        const same =
          a[0].toLowerCase() === b[0].toLowerCase() &&
          a[1].toLowerCase() === b[1].toLowerCase() &&
          a[2] === b[2];
        expect(reactionId(...a) === reactionId(...b)).toBe(same);
      }),
    );
  });
});

describe('summariseReactions (properties)', () => {
  it('counts every row once, marks mine exactly, and ignores the rows’ order', () => {
    fc.assert(
      fc.property(
        // The rows, and the same rows in any other arrival order.
        fc
          .array(row, { maxLength: 30 })
          .chain((rows) =>
            fc.tuple(fc.constant(rows), fc.shuffledSubarray(rows, { minLength: rows.length })),
          ),
        fc.constantFrom(...USERS),
        ([rows, shuffled], viewer) => {
          const chips = summariseReactions(rows, viewer);
          expect(chips.reduce((n, c) => n + c.count, 0)).toBe(rows.length);
          expect(new Set(chips.map((c) => c.emoji)).size).toBe(chips.length);
          for (const chip of chips) {
            const mine = rows.some((r) => r.emoji === chip.emoji && r.userId === viewer);
            expect(chip.mine, chip.emoji).toBe(mine);
          }
          // Any other arrival order gives the same chips.
          expect(summariseReactions(shuffled, viewer)).toEqual(chips);
        },
      ),
    );
  });
});
