// AC-11 (SPEC-005): every text/background pair reaches 4.5:1 and every meaningful icon or border
// reaches 3:1, in both themes (design-system §2.3). Run alone with `pnpm test:tokens`.
//
// USAGE is the contract for what each semantic colour may be used for. It is typed as a complete
// record, so a new token does not compile until it states its use here. A colour not listed as text
// on a surface must not be used as text on it (see the header of tokens/semantic.ts).
import { describe, expect, it } from 'vitest';
import { contrastRatio, luminance, resolveColor } from '../tokens/contrast.js';
import { LABEL_HUES, THEMES } from '../tokens/primitives.js';
import type { SemanticColor } from '../tokens/semantic.js';

const TEXT = 4.5;
const NON_TEXT = 3;

/** Surfaces that text and icons sit on. §2.3 names app/panel/elevated/hover/selected; sidebar and
 *  active are added because nav items and counts render on them. */
const SURFACES = [
  'bg-app',
  'bg-sidebar',
  'bg-panel',
  'bg-elevated',
  'bg-hover',
  'bg-elevated-hover',
  'bg-active',
  'bg-group',
  'bg-selected',
] as const satisfies readonly SemanticColor[];

/** Surfaces form controls sit on. */
const FORM_SURFACES = [
  'bg-app',
  'bg-sidebar',
  'bg-panel',
  'bg-elevated',
] as const satisfies readonly SemanticColor[];

const LABEL_TOKENS = LABEL_HUES.map((hue) => `label-${hue}` as const);

/** Banner and toast surfaces. */
const FEEDBACK_SUBTLE = [
  'danger-subtle',
  'warning-subtle',
  'success-subtle',
  'info-subtle',
] as const satisfies readonly SemanticColor[];

type Check = { min: number; on: readonly SemanticColor[]; why: string };
type Usage = { checks: readonly Check[] } | { exempt: string };

const text = (on: readonly SemanticColor[], why: string): Check => ({ min: TEXT, on, why });
const icon = (on: readonly SemanticColor[], why: string): Check => ({ min: NON_TEXT, on, why });
const surface: Usage = { exempt: 'a surface: checked as the background of other pairs' };
const label: Usage = { checks: [icon(SURFACES, 'label, team or project dot')] };

const USAGE = {
  'bg-app': surface,
  'bg-sidebar': surface,
  'bg-panel': surface,
  'bg-elevated': surface,
  'bg-hover': surface,
  'bg-elevated-hover': surface,
  'bg-active': surface,
  'bg-group': surface,
  'bg-selected': surface,
  'border-subtle': { exempt: 'decorative row separator (WCAG 1.4.11 does not apply)' },
  'border-hairline': { exempt: 'decorative hairline at half width (WCAG 1.4.11 does not apply)' },
  'border-default': { exempt: 'decorative card and panel edge; controls use --border-control' },
  'border-strong': { exempt: 'decorative menu divider; controls use --border-control' },
  'border-control': { checks: [icon(FORM_SURFACES, 'control boundary (WCAG 1.4.11)')] },
  'text-primary': { checks: [text([...SURFACES, ...FEEDBACK_SUBTLE], 'text')] },
  'text-secondary': { checks: [text([...SURFACES, ...FEEDBACK_SUBTLE], 'text')] },
  'text-tertiary': { checks: [text(SURFACES, 'text')] },
  'text-disabled': { exempt: 'disabled controls are exempt from contrast (WCAG 1.4.3)' },
  accent: {
    checks: [
      text(['bg-app', 'bg-panel', 'bg-elevated', 'bg-hover', 'bg-elevated-hover'], 'link text'),
      icon(SURFACES, 'accent icon or selection mark'),
    ],
  },
  'accent-hover': { checks: [text(['bg-app', 'bg-panel', 'bg-elevated'], 'hovered link text')] },
  'accent-subtle': surface,
  'on-accent': { checks: [text(['accent', 'accent-hover'], 'primary button label')] },
  'focus-ring': { checks: [icon(SURFACES, 'focus ring')] },
  danger: {
    checks: [
      text(['bg-app', 'bg-panel', 'bg-elevated'], 'field error text'),
      icon([...SURFACES, 'danger-subtle'], 'danger icon'),
    ],
  },
  'danger-hover': { exempt: 'only a button fill: checked as the background of --on-danger' },
  'danger-subtle': surface,
  'on-danger': { checks: [text(['danger', 'danger-hover'], 'danger button label')] },
  warning: { checks: [icon([...SURFACES, 'warning-subtle'], 'warning icon')] },
  'warning-subtle': surface,
  success: { checks: [icon([...SURFACES, 'success-subtle'], 'success icon')] },
  'success-subtle': surface,
  info: { checks: [icon([...SURFACES, 'info-subtle'], 'info icon')] },
  'info-subtle': surface,
  'label-gray': label,
  'label-red': label,
  'label-orange': label,
  'label-amber': label,
  'label-yellow': label,
  'label-lime': label,
  'label-green': label,
  'label-teal': label,
  'label-cyan': label,
  'label-blue': label,
  'label-violet': label,
  'label-pink': label,
  'on-label': {
    checks: [text(LABEL_TOKENS, 'avatar initials on a palette fill')],
  },
} as const satisfies Record<SemanticColor, Usage>;

function isSemantic(name: string): name is SemanticColor {
  return name in USAGE;
}

const pairs = Object.entries(USAGE).flatMap(([fg, usage]) =>
  'checks' in usage
    ? usage.checks.flatMap((c) => c.on.map((bg) => ({ fg, bg, min: c.min, why: c.why })))
    : [],
);

describe('contrast math', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#FFFFFF', '#777777')).toBe(contrastRatio('#777777', '#FFFFFF'));
  });

  it('rejects values that are not #RRGGBB', () => {
    expect(() => luminance('#FFF')).toThrow(/#RRGGBB/);
  });
});

describe.each(THEMES)('%s theme', (theme) => {
  it.each(pairs.map((p) => [`--${p.fg} on --${p.bg} (${p.why}) ≥ ${p.min}:1`, p] as const))(
    '%s',
    (_, { fg, bg, min }) => {
      if (!isSemantic(fg)) throw new Error(`--${fg} is not a semantic colour`);
      const ratio = contrastRatio(resolveColor(theme, fg), resolveColor(theme, bg));
      expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
    },
  );
});

describe('usage contract', () => {
  it('exempts only surfaces, decorative borders, disabled text and the danger button fill', () => {
    const exempt = Object.entries(USAGE)
      .filter(([, usage]) => 'exempt' in usage)
      .map(([name]) => name);
    const allowed =
      /^(bg-.*|.*-subtle|border-(subtle|hairline|default|strong)|text-disabled|danger-hover)$/;
    expect(exempt.filter((name) => !allowed.test(name))).toEqual([]);
  });
});

describe('row focus bar (PLAN-016 S4, D-f)', () => {
  it.each(THEMES)(
    'row focus bar passes 3:1 (accent and focus ring on --bg-active, %s)',
    (theme) => {
      const active = resolveColor(theme, 'bg-active');
      expect(contrastRatio(resolveColor(theme, 'accent'), active)).toBeGreaterThanOrEqual(NON_TEXT);
      expect(contrastRatio(resolveColor(theme, 'focus-ring'), active)).toBeGreaterThanOrEqual(
        NON_TEXT,
      );
    },
  );

  it.each(THEMES)(
    'the selected ring and row text pass on --bg-selected and --bg-group (%s)',
    (theme) => {
      const selected = resolveColor(theme, 'bg-selected');
      const group = resolveColor(theme, 'bg-group');
      expect(contrastRatio(resolveColor(theme, 'accent'), selected)).toBeGreaterThanOrEqual(
        NON_TEXT,
      );
      for (const token of ['text-primary', 'text-secondary', 'text-tertiary'] as const) {
        expect(contrastRatio(resolveColor(theme, token), selected)).toBeGreaterThanOrEqual(TEXT);
        expect(contrastRatio(resolveColor(theme, token), group)).toBeGreaterThanOrEqual(TEXT);
      }
    },
  );
});
