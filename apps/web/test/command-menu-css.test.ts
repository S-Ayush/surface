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

// PLAN-016 S5 (command-menu.md §1): no backdrop, top-anchored, 15px input, 40px neutral options.
describe('command menu frame css', () => {
  const dialogCss = readFileSync(
    new URL('../../../packages/ui/src/components/Dialog/Dialog.module.css', import.meta.url),
    'utf8',
  );
  const dialogTsx = readFileSync(
    new URL('../../../packages/ui/src/components/Dialog/Dialog.tsx', import.meta.url),
    'utf8',
  );
  const rule = (source: string, selector: string) =>
    new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';

  it('is anchored at --command-menu-top, not centred', () => {
    expect(rule(dialogCss, '\\.command')).toMatch(/top:\s*var\(--command-menu-top\)/);
    expect(rule(dialogCss, '\\.command')).toMatch(/max-width:\s*var\(--command-menu-width\)/);
  });

  it('keeps the overlay for the command menu but makes it fully transparent', () => {
    // Scroll lock and click-outside-closes need the layer; D-d only removes the dim and blur.
    const clear = rule(dialogCss, '\\.backdrop\\.clear');
    expect(clear).toMatch(/background:\s*transparent/);
    expect(clear).toMatch(/backdrop-filter:\s*none/);
    expect(dialogTsx).toMatch(/variant === 'command' && styles\.clear/);
  });

  it('has a 15px input, 40px options and a neutral active option', () => {
    expect(rule(css, '\\.input')).toMatch(/font-size:\s*var\(--text-md-size\)/);
    expect(css).toMatch(/height:\s*var\(--command-option-height\)/);
    expect(rule(css, "\\.option\\[aria-selected='true'\\]")).toMatch(/var\(--bg-active\)/);
  });
});
