// PLAN-016 S0 (audit row 26). The display text is padded so the edit box has room; a negative inline
// margin of the same size keeps the glyphs on the description's left edge.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  new URL('../src/components/EditableTitle/EditableTitle.module.css', import.meta.url),
  'utf8',
);

describe('editable title css', () => {
  it("the title's negative inline margin equals its padding", () => {
    const text = /(?:^|\n)\.text\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const padding = /padding:\s*var\(--space-\d+\)\s+var\((--space-\d+)\)/.exec(text)?.[1];
    expect(padding).toBeDefined();
    // The 1px transparent border also sits between the box edge and the glyphs.
    expect(text).toContain(`margin-inline: calc(-1 * (var(${padding}) + var(--border-width)))`);
    expect(text).toMatch(/width:\s*auto/);
  });
});
