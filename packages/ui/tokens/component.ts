// Scale and component layer (design-system §2.4–2.6, §3). Values are raw CSS: this file is a token
// file, so it may use px and rgb(); component CSS must use the generated custom properties instead.
import type { Theme } from './primitives.js';

/** Root font size in px. The "font size" preference (FR-AUTH-10, S7) switches it to 12, 13 or 14. */
export const ROOT_FONT_SIZE_PX = 13;
/** The other two roots: `html[data-font-size='small' | 'large']` (styles/base.css). */
const ROOT_FONT_SIZE_SMALL_PX = 12;
const ROOT_FONT_SIZE_LARGE_PX = 14;

const px = (n: number): string => `${n}px`;
/** Type sizes scale with the root font size, so they are expressed in rem of the 13 px default. */
const rem = (n: number): string => `${Number((n / ROOT_FONT_SIZE_PX).toFixed(4))}rem`;

/** Spacing on the 4 px grid. 2 and 6 are for tight icon alignment only (§2.5). Named by px value. */
const SPACING = [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64] as const;

/** Type ramp (§2.4): size / line height in px, and weight. */
const TYPE = {
  xs: [11, 16, 500],
  sm: [12, 16, 450],
  // Section labels (sidebar, command-menu groups, settings sections, property headings); the
  // colour is --text-tertiary, set where the style is used.
  label: [12, 16, 500],
  base: [13, 20, 450],
  md: [15, 24, 450],
  lg: [16, 24, 600],
  xl: [20, 28, 600],
  '2xl': [24, 32, 600],
} as const satisfies Record<string, readonly [number, number, number]>;

function typeTokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, [size, line, weight]] of Object.entries(TYPE)) {
    out[`text-${name}-size`] = rem(size);
    out[`text-${name}-line`] = rem(line);
    out[`text-${name}-weight`] = String(weight);
  }
  return out;
}

/** Theme-independent tokens. */
export const componentTokens: Readonly<Record<string, string>> = {
  // Typography (§2.4). Inter and JetBrains Mono are bundled; the rest of each stack is local fallback.
  'font-sans':
    "'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  'font-mono':
    "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  'font-features': '"cv11", "ss01"',
  'font-features-numeric': '"cv11", "ss01", "tnum"',
  'font-size-root': px(ROOT_FONT_SIZE_PX),
  'font-size-root-small': px(ROOT_FONT_SIZE_SMALL_PX),
  'font-size-root-large': px(ROOT_FONT_SIZE_LARGE_PX),
  // 450 for body text, 500 for UI labels (PLAN-016 S1); Inter Variable covers both.
  'weight-regular': '450',
  'weight-ui': '500',
  'weight-medium': '500',
  'weight-semibold': '600',
  // Tracking: tight for text of 15 px and up, a little more for identifiers. None elsewhere.
  'tracking-tight': '-0.0067em',
  'tracking-id': '-0.02em',
  ...typeTokens(),

  // Spacing (§2.5)
  ...Object.fromEntries(SPACING.map((n) => [`space-${n}`, px(n)])),

  // Sizing (§2.5)
  'control-sm': px(24),
  'control-md': px(28),
  'control-lg': px(32),
  'row-height': px(44),
  'row-height-compact': px(36),
  'group-header-height': px(36),
  // Rows and group headers sit inset in the card (design-system §5.3).
  'row-inset': px(8),
  'focus-bar-width': px(2),
  'nav-item-height': px(28),
  'settings-column': px(640),
  'settings-row-min-height': px(60),
  'board-card-min-height': px(72),
  'icon-sm': px(14),
  'icon-md': px(16),
  'icon-lg': px(20),
  'border-width': px(1),
  // Decorative border width (§2.5): 1 px here, 0.5 px on 2x screens (`hiResTokens`).
  hairline: px(1),
  'focus-ring-width': px(2),
  'focus-ring-offset': px(2),

  // Component sizes (§5.1). Kept here so component CSS never needs raw px.
  'avatar-xs': px(16),
  'avatar-sm': px(20),
  'avatar-md': px(24),
  'avatar-lg': px(32),
  'presence-size': px(8),
  'checkbox-size': px(16),
  'switch-width': px(28),
  'switch-height': px(16),
  'switch-thumb': px(12),
  'kbd-height': px(18),
  'swatch-size': px(20),
  'progress-height': px(4),
  'avatar-xs-font': rem(8),
  'avatar-sm-font': rem(9),
  'spinner-stroke': px(2),
  'tooltip-max-width': px(280),
  'empty-state-max-width': px(360),
  'empty-state-icon': px(24),
  // Overlays (§5.2): dialog widths sm/md/lg, and anchored surfaces.
  'dialog-sm': px(420),
  'dialog-md': px(560),
  'dialog-lg': px(720),
  // The command menu (command-menu.md §1): about 720 px wide, anchored 87 px from the top, at most
  // 60% of the viewport tall.
  'command-menu-width': px(720),
  'command-menu-top': px(87),
  'command-option-height': px(40),
  'menu-min-width': px(200),
  'menu-item-height': px(30),
  'popover-max-width': px(360),
  'toast-width': px(360),
  // Property picker and issue rows (SPEC-012 §3.3, §3.5).
  'picker-width': px(280),
  'picker-list-max-height': px(320),
  'dot-size': px(8),
  'row-id-width': px(64),
  'row-estimate-width': px(40),
  'row-date-width': px(64),
  'row-created-width': px(80),

  // Radius (§2.5)
  'radius-xs': px(4),
  'radius-kbd': px(3),
  'radius-sm': px(6),
  'radius-md': px(8),
  'radius-group': px(10),
  'radius-lg': px(12),
  'radius-full': px(9999),

  // Layout (§3)
  'sidebar-width': px(240),
  'sidebar-min-width': px(200),
  'sidebar-max-width': px(360),
  'header-height': px(44),
  // The content card's margin (§3); the shell sets it to 0 when full-bleed.
  'shell-inset': px(8),
  'peek-width': px(480),
  'properties-width': px(280),
  'content-max-width': px(760),

  // Z-index (§2.5)
  'z-base': '0',
  'z-sticky': '10',
  'z-sidebar': '20',
  // One level for every stacking overlay (popover, menu, dialog, command menu): they portal to
  // <body> in the order they open, so a menu opened inside a dialog lands above it. Separate
  // levels put a picker inside a modal behind the modal (PLAN-005 S3 review).
  'z-overlay': '50',
  'z-toast': '70',
  'z-tooltip': '80',

  // Motion (§2.6)
  'dur-instant': '0ms',
  'dur-fast': '100ms',
  'dur-base': '160ms',
  'dur-slow': '240ms',
  // Highlights turn on at once and fade out; overlays leave faster than they enter (§2.6).
  'dur-highlight-in': '0ms',
  'dur-highlight-out': '150ms',
  'dur-exit': '80ms',
  'ease-out': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  'ease-in': 'cubic-bezier(0.4, 0, 1, 1)',
  // Movement of entering overlays. Reduced motion swaps in `reducedMotionTokens`, leaving only the
  // opacity change (§2.6).
  'motion-shift': px(4),
  // Looping indicators (Spinner, Skeleton pulse, indeterminate progress) and the skeleton delay
  // (§4 "Loading": skeletons appear only after 150 ms, so fast loads never flash).
  'dur-spin': '800ms',
  'dur-loop': '1600ms',
  'skeleton-delay': '150ms',
  'motion-scale': '0.98',
};

/**
 * Tokens whose value differs per theme. Elevation (§2.5): light uses soft shadows; dark adds a 1 px
 * `--border-default` ring plus a deeper shadow, because shadows read poorly on dark backgrounds.
 */
export const themedComponentTokens: Readonly<Record<string, Readonly<Record<Theme, string>>>> = {
  // Stacked low-alpha layers, the first being a hairline ring (PLAN-016 S1, design-system §2.5).
  'shadow-e0': {
    light:
      '0 0 0 var(--hairline) var(--border-hairline), 0 1px 1px rgb(0 0 0 / 0.04), 0 3px 6px -2px rgb(0 0 0 / 0.02)',
    dark: '0 0 0 var(--hairline) var(--border-hairline), 0 0.5px 1px 1px rgb(0 0 0 / 0.3)',
  },
  'shadow-e1': {
    light:
      '0 0 0 var(--hairline) var(--border-hairline), 0 1px 1px rgb(0 0 0 / 0.04), 0 3px 9px rgb(0 0 0 / 0.04), 0 6px 18px rgb(0 0 0 / 0.02)',
    dark: '0 0 0 var(--hairline) var(--border-default), 0 1px 1px rgb(0 0 0 / 0.12), 0 2px 5px rgb(0 0 0 / 0.12), 0 3px 8px rgb(0 0 0 / 0.12)',
  },
  'shadow-e2': {
    light:
      '0 0 0 var(--hairline) var(--border-hairline), 0 1px 1px rgb(0 0 0 / 0.04), 0 6px 24px rgb(0 0 0 / 0.1), 0 9px 48px rgb(0 0 0 / 0.08)',
    dark: '0 0 0 var(--hairline) var(--border-default), 0 1px 1px rgb(0 0 0 / 0.12), 0 2px 8px rgb(0 0 0 / 0.12), 0 3px 12px rgb(0 0 0 / 0.12), 0 3px 20px rgb(0 0 0 / 0.12), 0 4px 40px rgb(0 0 0 / 0.1)',
  },
  // Toasts sit at the same depth as modals.
  'shadow-e3': {
    light:
      '0 0 0 var(--hairline) var(--border-hairline), 0 1px 1px rgb(0 0 0 / 0.04), 0 6px 24px rgb(0 0 0 / 0.1), 0 9px 48px rgb(0 0 0 / 0.08)',
    dark: '0 0 0 var(--hairline) var(--border-default), 0 1px 1px rgb(0 0 0 / 0.12), 0 2px 8px rgb(0 0 0 / 0.12), 0 3px 12px rgb(0 0 0 / 0.12), 0 3px 20px rgb(0 0 0 / 0.12), 0 4px 40px rgb(0 0 0 / 0.1)',
  },
  // Darkens a solid button while pressed.
  'pressed-shade': {
    light: 'rgb(0 0 0 / 0.14)',
    dark: 'rgb(0 0 0 / 0.22)',
  },
  backdrop: {
    light: 'rgb(22 24 29 / 0.32)',
    dark: 'rgb(0 0 0 / 0.6)',
  },
};

/**
 * Overrides under `prefers-reduced-motion: reduce`. Lengths keep a unit (`0px`, not `0`): a unitless 0
 * inside `calc(-50% + var(--motion-shift))` makes the whole transform invalid.
 */
export const reducedMotionTokens: Readonly<Record<string, string>> = {
  'motion-shift': px(0),
  'motion-scale': '1',
};

/** Overrides on screens at 2x or more, where a half pixel renders as a crisp line (§2.5). */
export const hiResTokens: Readonly<Record<string, string>> = {
  hairline: '0.5px',
};
