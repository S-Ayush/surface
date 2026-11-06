// WCAG 2.1 contrast math (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio), used by `pnpm test:tokens`.
import { primitivesFor, type Hex, type Theme } from './primitives.js';
import { semanticColors, type SemanticColor } from './semantic.js';

const HEX = /^#[0-9A-F]{6}$/i;

function channel(hex: Hex, offset: number): number {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of an sRGB colour. */
export function luminance(hex: Hex): number {
  if (!HEX.test(hex)) throw new Error(`Expected a #RRGGBB colour, got "${hex}"`);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** Contrast ratio between two colours, from 1 to 21. Order does not matter. */
export function contrastRatio(a: Hex, b: Hex): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** The hex value a semantic colour token resolves to in a theme. */
export function resolveColor(theme: Theme, token: SemanticColor): Hex {
  const ref = semanticColors[token][theme];
  const value = primitivesFor(theme).get(ref);
  if (!value) throw new Error(`--${token} (${theme}) refers to an unknown primitive --${ref}`);
  return value;
}
