import type { ComponentPropsWithRef } from 'react';
import { MARK_LOWER, MARK_UPPER, WORDMARK } from './paths.js';

// The fixed brand colours (brand.md §2). They are brand values, not theme tokens: the colour mark
// looks the same in both themes, so they live in the SVG, not in component CSS.
const BRAND_UPPER = '#2EC4BF';
const BRAND_LOWER = '#0A7A77';

type SvgProps = Omit<ComponentPropsWithRef<'svg'>, 'title' | 'viewBox' | 'children'>;

export type SurfaceMarkProps = SvgProps & {
  /** Square size in CSS pixels or any CSS length. Defaults to 1em; CSS can also size it. */
  size?: number | string;
  /** Both paths in `currentColor`, for one-colour places. */
  mono?: boolean;
  /** Gives the mark an accessible name. Without it the mark is decorative. */
  title?: string;
};

export type SurfaceLockupProps = SvgProps & {
  /** Height in CSS pixels or any CSS length; the width follows from the lockup's proportions. */
  height?: number | string;
  title?: string;
};

function a11y(title: string | undefined) {
  return title === undefined
    ? ({ 'aria-hidden': true, focusable: 'false' } as const)
    : ({ role: 'img', 'aria-label': title } as const);
}

/** The Surface mark (brand.md §2): two curved bands. Decorative unless given a `title`. */
export function SurfaceMark({ size = '1em', mono = false, title, ...props }: SurfaceMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      {...a11y(title)}
      {...props}
    >
      {title === undefined ? null : <title>{title}</title>}
      <path fill={mono ? 'currentColor' : BRAND_UPPER} d={MARK_UPPER} />
      <path fill={mono ? 'currentColor' : BRAND_LOWER} d={MARK_LOWER} />
    </svg>
  );
}

const LOCKUP_RATIO = 156.794 / 32;

/** The colour mark with the wordmark in `currentColor` (brand.md §3). Scales from its height. */
export function SurfaceLockup({ height = '1em', title, ...props }: SurfaceLockupProps) {
  const width = typeof height === 'number' ? height * LOCKUP_RATIO : undefined;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 156.794 32"
      width={width}
      height={height}
      {...a11y(title)}
      {...props}
    >
      {title === undefined ? null : <title>{title}</title>}
      <path fill={BRAND_UPPER} d={MARK_UPPER} />
      <path fill={BRAND_LOWER} d={MARK_LOWER} />
      <path fill="currentColor" d={WORDMARK} />
    </svg>
  );
}
