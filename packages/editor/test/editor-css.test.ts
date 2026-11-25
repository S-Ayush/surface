// PLAN-016 S6. jsdom does not compute CSS, so these read the stylesheet source.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/editor.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../../ui/src/styles/tokens.css', import.meta.url), 'utf8');

const SCOPE = ':is(.surface-editor-content, .surface-doc)';

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return '';
  return css.slice(start, css.indexOf('}', start));
}

const rem = (name: string): number =>
  Number(new RegExp(`--text-${name}-size:\\s*([\\d.]+)rem`).exec(tokens)?.[1]);

describe('editor body type', () => {
  it('body uses text-md and headings stay below the title and above body in weight', () => {
    const body = block('.surface-editor-content,\n.surface-doc');
    expect(body).toContain('font-size: var(--text-md-size)');
    expect(body).toContain('line-height: var(--text-md-line)');
    expect(body).toContain('font-weight: var(--text-md-weight)');
    const sizeOf = (tag: string): string =>
      /font-size:\s*var\(--text-(\w+)-size\)/.exec(block(`${SCOPE} ${tag}`))?.[1] ?? '';
    const [h1, h2, h3] = [sizeOf('h1'), sizeOf('h2'), sizeOf(':is(h3, h4)')];
    expect(rem(h1)).toBeLessThan(rem('2xl'));
    expect(rem(h1)).toBeGreaterThan(rem(h2));
    expect(rem(h2)).toBeGreaterThanOrEqual(rem(h3));
    expect(rem(h3)).toBeGreaterThanOrEqual(rem('md'));
    const weight = (name: string): number =>
      Number(new RegExp(`--${name}:\\s*(\\d+)`).exec(tokens)?.[1]);
    expect(block(`${SCOPE} :is(h3, h4)`)).toContain('font-weight: var(--weight-semibold)');
    expect(weight('weight-semibold')).toBeGreaterThan(weight('text-md-weight'));
  });

  it('task item checkbox aligns to the first line', () => {
    const label = block(`${SCOPE} li[data-type='taskItem'] > label`);
    expect(label).toContain('align-items: flex-start');
    expect(label).toContain('margin-top: calc((1lh - var(--checkbox-size)) / 2)');
  });
});
