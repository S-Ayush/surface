// PLAN-016 S8: a skeleton row has the final row geometry. It reads the density tokens (not
// hard-coded pixels), so it follows the row heights, and its delay is the 150 ms token.
// Reads the CSS source; jsdom does not compute CSS Modules.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  new URL('../src/components/Skeleton/Skeleton.module.css', import.meta.url),
  'utf8',
);
const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('Skeleton row', () => {
  it('skeleton rows use the density tokens and --radius-md', () => {
    const row = rule('.row');
    expect(row).toContain('height: var(--row-height);');
    expect(row).toContain('border-radius: var(--radius-md);');
    expect(rule("[data-density='compact'] .row")).toContain('height: var(--row-height-compact);');
    expect(row).not.toMatch(/height:\s*\d+px/);
  });

  it('appears after the 150ms skeleton delay and stops pulsing under reduced motion', () => {
    expect(tokens).toContain('--skeleton-delay: 150ms;');
    const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
    expect(reduced).toContain('animation: appear');
    expect(reduced).not.toContain('pulse');
  });
});
