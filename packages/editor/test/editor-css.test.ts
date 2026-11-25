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

  it('the paragraph inside a task item adds no top margin, so the first line sits at the box', () => {
    // The generic `p { margin: space-8 0 }` rule applies inside the item's content div. The div is a
    // flex item (its own formatting context), so that margin does not collapse and pushes the text
    // 8px below the label; the box then looks high. The item content must zero its first/last margins.
    const generic = block(`${SCOPE} :is(p, ul, ol, blockquote, pre, h1, h2, h3, h4)`);
    expect(generic).toContain('margin: var(--space-8) 0');
    const first = block(`${SCOPE} li[data-type='taskItem'] > div > :first-child`);
    expect(first).toContain('margin-top: 0');
    const last = block(`${SCOPE} li[data-type='taskItem'] > div > :last-child`);
    expect(last).toContain('margin-bottom: 0');
    // Specificity: the reset must beat the generic rule (it has more compound selectors).
    expect(css.indexOf(`li[data-type='taskItem'] > div > :first-child {`)).toBeGreaterThan(
      css.indexOf(`:is(p, ul, ol, blockquote, pre, h1, h2, h3, h4) {`),
    );
  });
});
