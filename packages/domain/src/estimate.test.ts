// PLAN-010 S1, SPEC-010 AC-8 and E5: the estimate values of §4.3 for every scale, with Extended
// and Allow zero on and off; `off` accepts none; 0 is a real value distinct from null; values off
// the current scale format as their number.
import { describe, expect, it } from 'vitest';
import {
  estimateValues,
  formatEstimate,
  isValidEstimate,
  type EstimateConfig,
} from './estimate.js';
import { ESTIMATE_SCALES, type EstimateScale } from './workspace.js';

const config = (scale: EstimateScale, extended = false, allowZero = false): EstimateConfig => ({
  scale,
  extended,
  allowZero,
});

describe('estimateValues (AC-8)', () => {
  it('matches SPEC-010 §4.3 for every scale, with and without Extended', () => {
    const expected: Record<EstimateScale, [number[], number[]]> = {
      off: [[], []],
      linear: [
        [1, 2, 3, 4, 5],
        [1, 2, 3, 4, 5, 6, 7],
      ],
      exponential: [
        [1, 2, 4, 8, 16],
        [1, 2, 4, 8, 16, 32, 64],
      ],
      fibonacci: [
        [1, 2, 3, 5, 8],
        [1, 2, 3, 5, 8, 13, 21],
      ],
      tshirt: [
        [1, 2, 3, 5, 8],
        [1, 2, 3, 5, 8, 13, 21],
      ],
    };
    for (const scale of ESTIMATE_SCALES) {
      const [plain, extended] = expected[scale];
      expect(estimateValues(config(scale)), scale).toEqual(plain);
      expect(estimateValues(config(scale, true)), `${scale} extended`).toEqual(extended);
    }
  });

  it('adds 0 first with Allow zero, on any scale but off', () => {
    expect(estimateValues(config('fibonacci', false, true))).toEqual([0, 1, 2, 3, 5, 8]);
    expect(estimateValues(config('tshirt', true, true))).toEqual([0, 1, 2, 3, 5, 8, 13, 21]);
    expect(estimateValues(config('off', true, true))).toEqual([]);
  });
});

describe('isValidEstimate (AC-8)', () => {
  it('accepts no value while the scale is off, whatever the toggles', () => {
    for (const value of [0, 1, 2, 3, 5, 8]) {
      expect(isValidEstimate(config('off', true, true), value)).toBe(false);
    }
  });

  it('accepts exactly the scale values', () => {
    expect(isValidEstimate(config('exponential'), 4)).toBe(true);
    expect(isValidEstimate(config('exponential'), 3)).toBe(false);
    expect(isValidEstimate(config('linear'), 6)).toBe(false);
    expect(isValidEstimate(config('linear', true), 6)).toBe(true);
    expect(isValidEstimate(config('linear'), -1)).toBe(false);
    expect(isValidEstimate(config('linear'), 2.5)).toBe(false);
  });

  it('treats 0 as a real value, valid only with Allow zero, and null as no estimate', () => {
    expect(isValidEstimate(config('linear'), 0)).toBe(false);
    expect(isValidEstimate(config('linear', false, true), 0)).toBe(true);
    // Clearing an estimate is always allowed, even with estimates off.
    expect(isValidEstimate(config('linear'), null)).toBe(true);
    expect(isValidEstimate(config('off'), null)).toBe(true);
  });
});

describe('formatEstimate (AC-8, E5)', () => {
  it('shows t-shirt sizes on the t-shirt scale', () => {
    const tshirt = config('tshirt', true);
    expect([1, 2, 3, 5, 8, 13, 21].map((v) => formatEstimate(tshirt, v))).toEqual([
      'XS',
      'S',
      'M',
      'L',
      'XL',
      'XXL',
      'XXXL',
    ]);
    expect(formatEstimate(config('tshirt', false, true), 0)).toBe('0');
  });

  it('shows numbers on the other scales', () => {
    expect(formatEstimate(config('fibonacci'), 8)).toBe('8');
    expect(formatEstimate(config('linear', false, true), 0)).toBe('0');
  });

  it('shows a value off the current scale as its number (E5)', () => {
    // 13 was written while Extended was on; it stays and reads as a number.
    expect(formatEstimate(config('tshirt'), 13)).toBe('13');
    expect(isValidEstimate(config('tshirt'), 13)).toBe(false);
    expect(formatEstimate(config('tshirt'), 4)).toBe('4');
    expect(formatEstimate(config('off'), 3)).toBe('3');
  });
});
