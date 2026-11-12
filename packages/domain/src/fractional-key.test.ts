// PLAN-010 S1: fractional-index keys (SPEC-010 §4.1). Examples; the order property is in
// `fractional-key.prop.test.ts`.
import { describe, expect, it } from 'vitest';
import { fractionalKeyBetween, fractionalKeyProblem, isFractionalKey } from './fractional-key.js';

describe('fractionalKeyBetween', () => {
  it('starts an empty list at a0, the first key the seed writes', () => {
    expect(fractionalKeyBetween(null, null)).toBe('a0');
  });

  it('continues the seed keys a0, a1 at the end with short keys', () => {
    expect(fractionalKeyBetween('a0', null)).toBe('a1');
    expect(fractionalKeyBetween('a1', null)).toBe('a2');
    expect(fractionalKeyBetween('a9', null)).toBe('aA');
    expect(fractionalKeyBetween('az', null)).toBe('b00');
  });

  it('goes before the first key without a fraction when it can', () => {
    expect(fractionalKeyBetween(null, 'a0')).toBe('Zz');
    expect(fractionalKeyBetween(null, 'a1')).toBe('a0');
    expect(fractionalKeyBetween(null, 'a1V')).toBe('a1');
  });

  it('puts a fraction between two adjacent integers', () => {
    expect(fractionalKeyBetween('a0', 'a1')).toBe('a0V');
    expect(fractionalKeyBetween('a0', 'a0V')).toBe('a0G');
    expect(fractionalKeyBetween('a0V', 'a1')).toBe('a0l');
  });

  it('uses the next integer when one fits between', () => {
    expect(fractionalKeyBetween('a0', 'a5')).toBe('a1');
  });

  it('returns a key strictly between its neighbours in byte order', () => {
    const pairs: [string | null, string | null][] = [
      ['a0', 'a1'],
      ['a0', 'a00001'],
      ['Zz', 'a0'],
      ['a0zzz', 'a1'],
      [null, 'A000000000000000000000000001'],
      ['zzzzzzzzzzzzzzzzzzzzzzzzzzz', null],
    ];
    for (const [a, b] of pairs) {
      const key = fractionalKeyBetween(a, b);
      expect(isFractionalKey(key), key).toBe(true);
      if (a !== null) expect(a < key, `${a} < ${key}`).toBe(true);
      if (b !== null) expect(key < b, `${key} < ${b}`).toBe(true);
    }
  });

  it('is deterministic, so the client predicts the key the server writes', () => {
    expect(fractionalKeyBetween('a3', 'a4')).toBe(fractionalKeyBetween('a3', 'a4'));
  });

  it('refuses neighbours out of order or equal', () => {
    expect(() => fractionalKeyBetween('a1', 'a0')).toThrow('must sort before');
    expect(() => fractionalKeyBetween('a1', 'a1')).toThrow('must sort before');
  });

  it('refuses malformed keys', () => {
    expect(() => fractionalKeyBetween('a', null)).toThrow('malformed integer part');
    expect(() => fractionalKeyBetween(null, 'a10')).toThrow('must not end in 0');
    expect(() => fractionalKeyBetween('a-1', null)).toThrow('only 0-9, A-Z and a-z');
  });
});

// Review of PLAN-010 S1: each place the integer part wraps or runs out.
describe('fractionalKeyBetween at the integer-part boundaries', () => {
  const smallest = `A${'0'.repeat(26)}`;
  const largest = `z${'z'.repeat(26)}`;

  it('wraps from the negative to the positive integers: Zz → a0', () => {
    expect(fractionalKeyBetween('Zz', null)).toBe('a0');
    expect(fractionalKeyBetween(null, 'a0')).toBe('Zz');
  });

  it('grows the integer part when its digits carry: az → b00', () => {
    expect(fractionalKeyBetween('az', null)).toBe('b00');
    expect(fractionalKeyBetween(null, 'b00')).toBe('az');
  });

  it('shrinks to the longest negative integer when prepending to the shortest one', () => {
    expect(fractionalKeyBetween(null, `B${'0'.repeat(25)}`)).toBe(`A${'z'.repeat(26)}`);
  });

  it('appends a fraction after the largest integer, which has no next one', () => {
    expect(fractionalKeyBetween(largest, null)).toBe(`${largest}V`);
    expect(fractionalKeyBetween(`${largest}V`, null)).toBe(`${largest}l`);
  });

  it('prepends a fraction to the smallest integer instead of returning it bare', () => {
    // The integer before A0…01 is A0…00, which is reserved: alone it is not a valid key.
    const key = fractionalKeyBetween(null, `A${'0'.repeat(25)}1`);
    expect(key).toBe(`${smallest}V`);
    expect(isFractionalKey(key)).toBe(true);
    // And prepending keeps working from there.
    const next = fractionalKeyBetween(null, key);
    expect(next).toBe(`${smallest}G`);
    expect(isFractionalKey(next)).toBe(true);
    expect(fractionalKeyBetween(null, `${smallest}1`)).toBe(`${smallest}0V`);
  });

  it('prepends without a fraction when the first key has one', () => {
    expect(fractionalKeyBetween(null, 'a0V')).toBe('a0');
    expect(fractionalKeyBetween(null, 'Zz1')).toBe('Zz');
  });
});

describe('fractionalKeyProblem', () => {
  it('accepts integer keys and keys with a fraction', () => {
    for (const key of ['a0', 'a1', 'Zz', 'b00', 'a0V', 'A000000000000000000000000001']) {
      expect(fractionalKeyProblem(key), key).toBeUndefined();
    }
  });

  it('rejects empty, short, trailing-zero, reserved and non-ASCII keys', () => {
    for (const key of ['', 'b0', 'a0V0', 'A00000000000000000000000000', 'a0é', '0a']) {
      expect(fractionalKeyProblem(key), key).toBeDefined();
    }
  });
});
