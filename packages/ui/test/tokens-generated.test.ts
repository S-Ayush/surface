import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { OUTPUTS, duplicateNames, render } from '../scripts/build-tokens.js';
import { token } from '../src/tokens.gen.js';
import { componentTokens, reducedMotionTokens } from '../tokens/component.js';
import { semanticColors } from '../tokens/semantic.js';

describe('generated tokens', () => {
  it('are up to date with packages/ui/tokens (run `pnpm ui:tokens` if this fails)', async () => {
    const expected = await render();
    expect(await readFile(OUTPUTS.css, 'utf8')).toBe(expected.css);
    expect(await readFile(OUTPUTS.ts, 'utf8')).toBe(expected.ts);
  });

  it('define every semantic colour for light, dark and the OS-dark fallback', async () => {
    const css = (await render()).css;
    for (const name of Object.keys(semanticColors)) {
      expect(css.match(new RegExp(`--${name}: var\\(`, 'g')), name).toHaveLength(3);
    }
  });

  it('expose typed var() references for semantic and component tokens', () => {
    expect(token.bgApp).toBe('var(--bg-app)');
    expect(token.text2xlSize).toBe('var(--text-2xl-size)');
    expect(Object.keys(token).length).toBeGreaterThanOrEqual(
      Object.keys(semanticColors).length + Object.keys(componentTokens).length,
    );
  });

  it('keep primitives out of the typed constants, so components cannot reach them', () => {
    expect(Object.values(token)).not.toContain('var(--gray-1)');
  });
});

describe('PLAN-016 S1 tokens', () => {
  it('expose the new type, motion, radius, size and surface tokens', () => {
    const names = [
      'weightRegular',
      'weightUi',
      'trackingTight',
      'trackingId',
      'textLabelSize',
      'radiusGroup',
      'radiusKbd',
      'shadowE0',
      'durHighlightIn',
      'durHighlightOut',
      'durExit',
      'navItemHeight',
      'headerHeight',
      'settingsColumn',
      'settingsRowMinHeight',
      'commandMenuTop',
      'hairline',
      'bgGroup',
      'borderHairline',
    ] as const;
    for (const name of names) expect(token[name], name).toMatch(/^var\(--/);
  });

  it('sets regular text to 450, UI labels to 500 and text-md to 15/24', () => {
    expect(componentTokens['weight-regular']).toBe('450');
    expect(componentTokens['weight-ui']).toBe('500');
    expect(componentTokens['text-md-size']).toBe(`${Number((15 / 13).toFixed(4))}rem`);
    expect(componentTokens['text-md-line']).toBe(`${Number((24 / 13).toFixed(4))}rem`);
  });

  it('sets list rows to 44 (comfortable) and 36 (compact), group headers to 36 (D-c)', () => {
    expect(componentTokens['row-height']).toBe('44px');
    expect(componentTokens['row-height-compact']).toBe('36px');
    expect(componentTokens['group-header-height']).toBe('36px');
  });
});

describe('token generator', () => {
  it('reports a name declared by two layers, so one cannot silently override the other', () => {
    expect(
      duplicateNames({ component: ['icon-md', 'row-height'], themed: ['icon-md'], semantic: [] }),
    ).toEqual(['--icon-md (component and themed)']);
    expect(duplicateNames({ primitive: ['gray-1'], semantic: ['bg-app'] })).toEqual([]);
  });

  it('keeps the unit of every reduced-motion override, so calc() stays valid', () => {
    const unit = (value: string): string =>
      /^-?[\d.]+([a-z%]*)$/.exec(value)?.[1] ?? 'not a number';
    for (const [name, reduced] of Object.entries(reducedMotionTokens)) {
      expect(unit(reduced), `--${name}: ${reduced}`).toBe(unit(componentTokens[name] ?? ''));
    }
  });
});
