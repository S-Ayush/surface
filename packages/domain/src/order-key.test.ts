// PLAN-011 S3, SPEC-011 §4.5 and §6.2, AC-2 (unit part): issue order keys. Any sequence of
// `keyBefore` and `keyBetween` keeps a strict byte order with no duplicates; equal neighbours
// with different jitter give different keys; the optimistic jitter is a function of the id.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isFractionalKey } from './fractional-key.js';
import {
  isJitter,
  jitterFrom,
  jitterFromId,
  JITTER_LENGTH,
  keyBefore,
  keyBetween,
} from './order-key.js';

/** Byte order, the order of `COLLATE "C"` (keys are ASCII). */
function byteCompare(a: string, b: string): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return Math.sign(d);
  }
  return Math.sign(a.length - b.length);
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
const digit = fc.oneof(fc.constantFrom('0', '1', 'y', 'z'), fc.constantFrom(...DIGITS));

/** Any valid fractional key, often near an integer boundary (as in `fractional-key.prop.test.ts`). */
const anyKey: fc.Arbitrary<string> = fc
  .oneof(fc.constantFrom('A', 'Z', 'a', 'z'), fc.constantFrom(...HEADS))
  .chain((head) => {
    const length = head >= 'a' ? head.charCodeAt(0) - 97 + 2 : 90 - head.charCodeAt(0) + 2;
    const integer = fc.oneof(
      fc.array(digit, { minLength: length - 1, maxLength: length - 1 }).map((d) => d.join('')),
      fc
        .record({ fill: fc.constantFrom('0', 'z'), tail: fc.array(digit, { maxLength: 2 }) })
        .map(({ fill, tail }) => (fill.repeat(length - 1) + tail.join('')).slice(-(length - 1))),
    );
    return fc
      .record({ integer, fraction: fc.array(digit, { maxLength: 6 }) })
      .map(({ integer: i, fraction }) => head + i + fraction.join('').replace(/0+$/, ''));
  })
  .filter(isFractionalKey);

const jitter = fc.nat({ max: Number.MAX_SAFE_INTEGER }).map(jitterFrom);

type Step = { readonly kind: 'first' } | { readonly kind: 'between'; readonly at: number };
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.constant({ kind: 'first' as const }),
  fc.record({ kind: fc.constant('between' as const), at: fc.nat() }),
);

describe('keyBefore and keyBetween (AC-2 property)', () => {
  it('keep any sequence of creates and inserts in strict byte order with no duplicates', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(step, jitter), { maxLength: 150 }), (steps) => {
        let keys: string[] = [];
        for (const [s, j] of steps) {
          const list = [...keys];
          if (s.kind === 'first') {
            list.unshift(keyBefore(list[0] ?? null, j));
          } else {
            const at = s.at % (list.length + 1);
            list.splice(at, 0, keyBetween(list[at - 1] ?? null, list[at] ?? null, j));
          }
          expectStrictOrder(list);
          keys = list;
        }
      }),
    );
  });

  it('return a valid key strictly between any two valid keys, and before or after any key', () => {
    fc.assert(
      fc.property(anyKey, anyKey, jitter, (x, y, j) => {
        expectStrictOrder([keyBefore(x, j), x]);
        expectStrictOrder([x, keyBetween(x, null, j)]);
        fc.pre(x !== y);
        const [a, b] = x < y ? [x, y] : [y, x];
        expectStrictOrder([a, keyBetween(a, b, j), b]);
      }),
      { numRuns: 5000 },
    );
  });

  it('give different keys for equal neighbours and different jitter', () => {
    fc.assert(
      fc.property(fc.option(anyKey, { nil: null }), jitter, jitter, (first, j1, j2) => {
        fc.pre(j1 !== j2);
        expect(keyBefore(first, j1)).not.toBe(keyBefore(first, j2));
      }),
    );
  });

  it('keep keys short when every new issue goes first', () => {
    // Q7: a new issue goes before the team's lowest key, so this is the common path.
    let first: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 2000; i++) {
      first = keyBefore(first, jitterFrom(i * 7919));
      keys.unshift(first);
    }
    expectStrictOrder(keys);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(3 + JITTER_LENGTH);
  });

  it('refuse jitter that would break the key format', () => {
    expect(() => keyBefore(null, 'ab0')).toThrow(/jitter/);
    expect(() => keyBefore(null, 'abc0')).toThrow(/jitter/);
    expect(() => keyBetween('a0', 'a1', 'ab-c')).toThrow(/jitter/);
  });
});

describe('jitter', () => {
  it('is always four base-62 digits that never end in 0', () => {
    fc.assert(
      fc.property(fc.nat({ max: Number.MAX_SAFE_INTEGER }), (n) => isJitter(jitterFrom(n))),
    );
    expect(jitterFrom(0)).toBe('0001');
  });

  it('comes from the issue id deterministically, whatever its case (SPEC-011 §6.2)', () => {
    fc.assert(
      fc.property(fc.uuid(), (id) => {
        expect(jitterFromId(id)).toBe(jitterFromId(id));
        expect(jitterFromId(id.toUpperCase())).toBe(jitterFromId(id));
        expect(isJitter(jitterFromId(id))).toBe(true);
      }),
    );
  });

  it('differs between ids that differ only in their last character', () => {
    const base = '0190f0c0-0000-7000-8000-00000000000';
    const jitters = new Set('0123456789abcdef'.split('').map((c) => jitterFromId(base + c)));
    expect(jitters.size).toBe(16);
  });
});
