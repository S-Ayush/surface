// PLAN-010 S1, SPEC-010 AC-3 (property part): any sequence of inserts and moves, starting from
// the seed's keys, keeps a strict total order under byte comparison with no duplicate keys.
// A list is modelled as its rows in display order; each step computes the new key from the
// neighbours at the target position, as the status handlers and their `optimistic` do.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fractionalKeyBetween, isFractionalKey } from './fractional-key.js';

type Step =
  | { readonly kind: 'insert'; readonly at: number }
  | { readonly kind: 'move'; readonly from: number; readonly to: number };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('insert' as const), at: fc.nat() }),
  fc.record({ kind: fc.constant('move' as const), from: fc.nat(), to: fc.nat() }),
);

/**
 * Byte order, the order of `COLLATE "C"`. Keys are ASCII (checked by `isFractionalKey`), so each
 * character is one byte and its code is the byte's value.
 */
function byteCompare(a: string, b: string): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return Math.sign(d);
  }
  return Math.sign(a.length - b.length);
}

/** Applies `step` to `keys` (display order) and returns the new display order. */
function apply(keys: readonly string[], s: Step): string[] {
  const list = [...keys];
  if (s.kind === 'insert') {
    const at = s.at % (list.length + 1);
    list.splice(at, 0, fractionalKeyBetween(list[at - 1] ?? null, list[at] ?? null));
    return list;
  }
  if (list.length === 0) return list;
  const from = s.from % list.length;
  list.splice(from, 1);
  const to = s.to % (list.length + 1);
  list.splice(to, 0, fractionalKeyBetween(list[to - 1] ?? null, list[to] ?? null));
  return list;
}

function expectStrictOrder(keys: readonly string[]): void {
  for (const key of keys) expect(isFractionalKey(key), key).toBe(true);
  expect(new Set(keys).size).toBe(keys.length);
  for (let i = 1; i < keys.length; i++) {
    expect(byteCompare(keys[i - 1] ?? '', keys[i] ?? ''), `${keys[i - 1]} < ${keys[i]}`).toBe(-1);
  }
}

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');
const HEADS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');

/** A digit, often one next to the ends, so carries and borrows happen. */
const digit = fc.oneof(fc.constantFrom('0', '1', 'y', 'z'), fc.constantFrom(...DIGITS));

/**
 * An integer part's digits after the head: random, or all `0` or all `z` but for a short random
 * tail, which reaches the smallest and largest integers and carries through every digit.
 */
function integerDigits(length: number): fc.Arbitrary<string> {
  return fc.oneof(
    fc.array(digit, { minLength: length, maxLength: length }).map((d) => d.join('')),
    fc
      .record({ fill: fc.constantFrom('0', 'z'), tail: fc.array(digit, { maxLength: 2 }) })
      .map(({ fill, tail }) => (fill.repeat(length) + tail.join('')).slice(-length)),
  );
}

/** Any valid key: a head letter (often one at a wrap point), its integer digits, a fraction. */
const anyKey: fc.Arbitrary<string> = fc
  .oneof(fc.constantFrom('A', 'B', 'Z', 'a', 'b', 'z'), fc.constantFrom(...HEADS))
  .chain((head) => {
    const length = head >= 'a' ? head.charCodeAt(0) - 97 + 2 : 90 - head.charCodeAt(0) + 2;
    return fc
      .record({
        integer: integerDigits(length - 1),
        fraction: fc.oneof(fc.constant([]), fc.array(digit, { maxLength: 4 })),
      })
      .map(({ integer, fraction }) => head + integer + fraction.join('').replace(/0+$/, ''));
  })
  .filter(isFractionalKey);

describe('fractionalKeyBetween over arbitrary valid keys', () => {
  it('returns a valid key strictly between any two, across every integer boundary', () => {
    fc.assert(
      fc.property(anyKey, anyKey, (x, y) => {
        fc.pre(x !== y);
        const [a, b] = x < y ? [x, y] : [y, x];
        expectStrictOrder([a, fractionalKeyBetween(a, b), b]);
      }),
      { numRuns: 2000 },
    );
  });

  it('returns a valid key before or after any key', () => {
    fc.assert(
      fc.property(anyKey, (key) => {
        expectStrictOrder([fractionalKeyBetween(null, key), key]);
        // The largest integer has no next one, so it gets a fraction instead.
        expectStrictOrder([key, fractionalKeyBetween(key, null)]);
      }),
      // Enough runs to reach the integer just above the reserved smallest one (review finding).
      { numRuns: 10_000 },
    );
  });
});

describe('fractionalKeyBetween (AC-3 property)', () => {
  it('keeps any insert and move sequence in strict byte order with no duplicates', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.array(step, { maxLength: 120 }),
        (seeded, steps) => {
          // The seed writes a0, a1, … per category (handlers/teams/seed.ts).
          let keys = Array.from({ length: seeded }, (_, n) => `a${n}`);
          for (const s of steps) {
            keys = apply(keys, s);
            expectStrictOrder(keys);
          }
        },
      ),
    );
  });

  it('keeps order when every insert goes into the same gap', () => {
    // The worst case for key length: always between the first two rows.
    let keys = ['a0', 'a1'];
    for (let i = 0; i < 500; i++) keys = apply(keys, { kind: 'insert', at: 1 });
    expectStrictOrder(keys);
    for (let i = 0; i < 500; i++) keys = apply(keys, { kind: 'insert', at: 0 });
    expectStrictOrder(keys);
  });

  it('returns a valid key strictly between any two valid keys it produced', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 2, maxLength: 60 }), fc.nat(), (steps, pick) => {
        let keys: string[] = [];
        for (const s of steps) keys = apply(keys, s);
        fc.pre(keys.length >= 2);
        const i = pick % (keys.length - 1);
        const a = keys[i] ?? '';
        const b = keys[i + 1] ?? '';
        expectStrictOrder([a, fractionalKeyBetween(a, b), b]);
      }),
    );
  });
});
