// PLAN-016 S0 (audit row 18). The global `:focus-visible` rule in base.css has specificity (0,1,0),
// the same as a bare `.input`, so the menu's `outline: none` lost whenever base.css came later.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  new URL('../src/command-menu/CommandMenu.module.css', import.meta.url),
  'utf8',
);

describe('command menu css', () => {
  it('the command menu input removes the global focus ring with higher specificity', () => {
    const match = /(?:^|\n)\.input:focus-visible\s*\{([^}]*)\}/.exec(css);
    expect(match?.[1] ?? '').toMatch(/outline:\s*none/);
  });
});
