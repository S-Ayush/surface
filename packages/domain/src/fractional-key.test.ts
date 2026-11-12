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
