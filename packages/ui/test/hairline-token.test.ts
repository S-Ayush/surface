// PLAN-016 S1, design-system §2.5: --hairline is 0.5px on 2x screens and 1px everywhere else.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { OUTPUTS } from '../scripts/build-tokens.js';

const css = await readFile(OUTPUTS.css, 'utf8');

/** The first at-rule that starts with `header`, braces included ('' when absent). */
function atRule(header: string): string {
  const start = css.indexOf(header);
  if (start === -1) return '';
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  return '';
}

const HI_RES = '@media (min-resolution: 2dppx)';

describe('hairline token', () => {
  it('hairline falls back to 1px without the 2dppx query', () => {
    const outsideQuery = css.replace(atRule(HI_RES), '');
    expect(outsideQuery).toMatch(/--hairline: 1px;/);
    expect(outsideQuery).not.toMatch(/--hairline: 0\.5px/);
  });

  it('hairline is 0.5px under the 2dppx query', () => {
    expect(atRule(HI_RES)).toMatch(/--hairline: 0\.5px;/);
  });

  it('keeps the control border at a full pixel on every screen', () => {
    expect(css).toMatch(/--border-width: 1px;/);
    expect(atRule(HI_RES)).not.toMatch(/--border-width/);
  });

  it('draws the stacked shadows with the hairline, so they thin out on 2x screens too', () => {
    for (const level of ['e0', 'e1', 'e2', 'e3']) {
      expect(css).toMatch(new RegExp(`--shadow-${level}:\\s+0 0 0 var\\(--hairline\\)`));
    }
  });
});

describe('reduced motion', () => {
  it('still collapses movement, and the new exit and highlight tokens are times, not distances', () => {
    const reduced = atRule('@media (prefers-reduced-motion: reduce)');
    expect(reduced).toMatch(/--motion-shift: 0px;/);
    expect(reduced).toMatch(/--motion-scale: 1;/);
    for (const name of ['dur-exit', 'dur-highlight-in', 'dur-highlight-out']) {
      expect(css).toMatch(new RegExp(`--${name}: \\d+ms;`));
    }
  });
});
