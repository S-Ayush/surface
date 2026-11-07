import { describe, expect, it } from 'vitest';
import { structurallyEqual } from '../src/app/equal.js';

describe('structurallyEqual', () => {
  it('treats fresh arrays and objects with the same contents as equal', () => {
    expect(structurallyEqual([{ id: 'a', key: 'ENG' }], [{ id: 'a', key: 'ENG' }])).toBe(true);
    expect(structurallyEqual({ width: 240, open: false }, { open: false, width: 240 })).toBe(true);
    expect(structurallyEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(structurallyEqual(null, null)).toBe(true);
  });

  it('tells different contents apart', () => {
    expect(structurallyEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(structurallyEqual([1, 2], [2, 1])).toBe(false);
    expect(structurallyEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(structurallyEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(structurallyEqual({ a: undefined }, { b: undefined })).toBe(false);
    expect(structurallyEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(structurallyEqual([], {})).toBe(false);
    expect(structurallyEqual(0, -0)).toBe(false);
    expect(structurallyEqual(null, undefined)).toBe(false);
  });

  it('compares class instances (a store, a model row) by identity only', () => {
    class Box {
      constructor(readonly value: number) {}
    }
    const box = new Box(1);
    expect(structurallyEqual(box, box)).toBe(true);
    expect(structurallyEqual(new Box(1), new Box(1))).toBe(false);
  });
});
