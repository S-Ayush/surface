// Semantic layer (design-system §2.1): the only colour tokens components may use. Each token names a
// primitive per theme, so `--bg-app` resolves to `var(--gray-2)` in light and `var(--gray-1)` in dark.
//
// What each colour may be used for is a contract enforced by test/contrast.test.ts (design-system
// §2.3). In short: --text-* on any surface; --accent as text only on app/panel/elevated/hover;
// --danger as text only on app/panel/elevated (field errors); --warning, --success, --info and
// --label-* are icon and dot colours only (3:1), never text; banner and toast text uses --text-*.
import type { Theme } from './primitives.js';

/** A reference to a primitive by its custom-property name, e.g. `gray-2` or `hue-red`. */
export type PrimitiveRef = string;

type Themed = Readonly<Record<Theme, PrimitiveRef>>;
const same = (ref: PrimitiveRef): Themed => ({ light: ref, dark: ref });

export const semanticColors = {
  // Surfaces
  'bg-app': same('surface-1'),
  // The sidebar sits on the app layer; the content is an inset card on --bg-panel (PLAN-016 S1).
  'bg-sidebar': same('surface-1'),
  'bg-panel': same('surface-2'),
  'bg-elevated': same('surface-3'),
  'bg-hover': same('surface-4'),
  // Hovered or highlighted item on --bg-elevated (menus, pickers): --bg-hover is a step from it.
  'bg-elevated-hover': same('surface-8'),
  'bg-active': same('surface-5'),
  // Group header band: between panel and hover, never the hover colour.
  'bg-group': same('surface-6'),
  'bg-selected': same('teal-3'),

  // Borders
  'border-subtle': same('gray-5'),
  // Decorative hairlines (panel, header, chips, menus): drawn at --hairline width.
  'border-hairline': same('surface-7'),
  'border-default': same('gray-7'),
  'border-strong': same('gray-8'),
  // Boundary of a control (input, checkbox, switch) whose edge is its only outline: WCAG 1.4.11.
  'border-control': same('gray-9'),

  // Text
  'text-primary': same('gray-12'),
  'text-secondary': same('gray-11'),
  'text-tertiary': same('gray-10'),
  'text-disabled': same('gray-9'),

  // Accent
  accent: same('teal-9'),
  'accent-hover': same('teal-10'),
  'accent-subtle': same('teal-3'),
  'on-accent': { light: 'gray-1', dark: 'teal-1' },
  'focus-ring': { light: 'teal-8', dark: 'teal-10' },

  // Feedback
  danger: same('red-9'),
  'danger-hover': same('red-10'),
  'danger-subtle': same('red-3'),
  'on-danger': same('gray-1'),
  warning: same('amber-9'),
  'warning-subtle': same('amber-3'),
  success: same('green-9'),
  'success-subtle': same('green-3'),
  info: same('blue-9'),
  'info-subtle': same('blue-3'),

  // Code syntax colours that --success, --warning and --info cannot be, because those are icon
  // colours (3:1) and code is text (4.5:1 on --bg-panel). Keywords use --accent, comments
  // --text-secondary and removed lines --danger.
  'syntax-string': same('green-11'),
  'syntax-number': same('amber-11'),
  'syntax-title': same('blue-9'),

  // Label, team and project palette (design-system §2.2)
  'label-gray': same('hue-gray'),
  'label-red': same('hue-red'),
  'label-orange': same('hue-orange'),
  'label-amber': same('hue-amber'),
  'label-yellow': same('hue-yellow'),
  'label-lime': same('hue-lime'),
  'label-green': same('hue-green'),
  'label-teal': same('hue-teal'),
  'label-cyan': same('hue-cyan'),
  'label-blue': same('hue-blue'),
  'label-violet': same('hue-violet'),
  'label-pink': same('hue-pink'),
  // Text on a label-hue fill, e.g. avatar initials.
  'on-label': { light: 'gray-12', dark: 'gray-1' },
} as const satisfies Readonly<Record<string, Themed>>;

export type SemanticColor = keyof typeof semanticColors;
