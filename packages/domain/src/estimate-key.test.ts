// SPEC-012 §3.5 (estimate quick keys), AC-7.
import { describe, expect, it } from 'vitest';
import { estimateForDigit, type EstimateOption } from './estimate-key.js';

const fibonacci: EstimateOption[] = [1, 2, 3, 5, 8].map((value) => ({ value, label: `${value}` }));
const tshirt: EstimateOption[] = [
  { value: 1, label: 'XS' },
  { value: 2, label: 'S' },
  { value: 3, label: 'M' },
  { value: 5, label: 'L' },
  { value: 8, label: 'XL' },
];

describe('estimateForDigit', () => {
  it('clears the estimate on 0, on every scale', () => {
    expect(estimateForDigit(fibonacci, 0)).toBeNull();
    expect(estimateForDigit(tshirt, 0)).toBeNull();
    expect(estimateForDigit([], 0)).toBeNull();
  });

  it('picks the value equal to the digit (fibonacci 5 is 5)', () => {
    expect(estimateForDigit(fibonacci, 5)).toBe(5);
    expect(estimateForDigit(fibonacci, 8)).toBe(8);
  });

  it('picks by value on a t-shirt scale (5 is L)', () => {
    expect(estimateForDigit(tshirt, 5)).toBe(5);
    expect(estimateForDigit(tshirt, 2)).toBe(2);
  });

  it('does nothing for a digit the scale does not offer', () => {
    expect(estimateForDigit(fibonacci, 4)).toBeUndefined();
    expect(estimateForDigit(fibonacci, 9)).toBeUndefined();
    expect(estimateForDigit([], 3)).toBeUndefined();
  });

  it('does nothing for something that is not a digit', () => {
    expect(estimateForDigit(fibonacci, 10)).toBeUndefined();
    expect(estimateForDigit(fibonacci, -1)).toBeUndefined();
    expect(estimateForDigit(fibonacci, 1.5)).toBeUndefined();
  });

  it('does not pick an extended value above 9 by a digit', () => {
    const extended = [...fibonacci, { value: 13, label: '13' }];
    expect(estimateForDigit(extended, 1)).toBe(1);
    expect(estimateForDigit(extended, 3)).toBe(3);
  });
});
