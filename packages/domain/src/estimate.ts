/**
 * Estimate scales (SPEC-010 §4.3, D12, D21). Estimates are stored as integers; a team's settings
 * decide which values can be **written** and how they are shown. Changing the settings never
 * rewrites issues, so a stored value may be off the current scale: it is shown as its number.
 */
import type { EstimateScale } from './workspace.js';

/** A team's estimate settings, as `teams.estimate_scale`, `_extended` and `_allow_zero`. */
export interface EstimateConfig {
  readonly scale: EstimateScale;
  readonly extended: boolean;
  readonly allowZero: boolean;
}

interface ScaleValues {
  readonly base: readonly number[];
  /** The two larger values "Extended" adds. */
  readonly extended: readonly number[];
}

const SCALES: Readonly<Record<Exclude<EstimateScale, 'off'>, ScaleValues>> = {
  linear: { base: [1, 2, 3, 4, 5], extended: [6, 7] },
  exponential: { base: [1, 2, 4, 8, 16], extended: [32, 64] },
  fibonacci: { base: [1, 2, 3, 5, 8], extended: [13, 21] },
  tshirt: { base: [1, 2, 3, 5, 8], extended: [13, 21] },
};

/** How t-shirt values are shown (SPEC-010 §4.3). */
const TSHIRT_SIZES: ReadonlyMap<number, string> = new Map([
  [1, 'XS'],
  [2, 'S'],
  [3, 'M'],
  [5, 'L'],
  [8, 'XL'],
  [13, 'XXL'],
  [21, 'XXXL'],
]);

/** The values a picker offers and a write accepts, ascending. None while the scale is `off`. */
export function estimateValues(config: EstimateConfig): number[] {
  if (config.scale === 'off') return [];
  const { base, extended } = SCALES[config.scale];
  return [...(config.allowZero ? [0] : []), ...base, ...(config.extended ? extended : [])];
}

/**
 * Whether `value` may be written as an issue's estimate under `config`. `null` (no estimate) is
 * always allowed, even with the scale `off`; 0 is a real estimate, allowed only with Allow zero.
 */
export function isValidEstimate(config: EstimateConfig, value: number | null): boolean {
  if (value === null) return true;
  return estimateValues(config).includes(value);
}

/**
 * How a stored estimate reads: a t-shirt size on the t-shirt scale, else its number. A value off
 * the current scale (E5) is shown as its number; `isValidEstimate` says whether to style it as
 * off-scale. With the scale `off` estimates are hidden, so this is for the cases that still show
 * one (history).
 */
export function formatEstimate(config: EstimateConfig, value: number): string {
  if (config.scale === 'tshirt' && isValidEstimate(config, value)) {
    return TSHIRT_SIZES.get(value) ?? String(value);
  }
  return String(value);
}
