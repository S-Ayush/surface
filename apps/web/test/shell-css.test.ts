// PLAN-016 S0. jsdom does not compute styles from CSS Modules, so these read the source text.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/shell/Shell.module.css', import.meta.url), 'utf8');

function body(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? '';
}

const tokens = readFileSync(
  new URL('../../../packages/ui/tokens/component.ts', import.meta.url),
  'utf8',
);

// PLAN-016 S3
describe('shell card and sidebar css', () => {
  it('the content card is an inset panel with a hairline, e0 and the large radius', () => {
    const rule = body('.main');
    expect(rule).toMatch(/background:\s*var\(--bg-panel\)/);
    expect(rule).toMatch(/border-radius:\s*var\(--radius-lg\)/);
    expect(rule).toMatch(/border:\s*var\(--hairline\)\s+solid\s+var\(--border-hairline\)/);
    expect(rule).toMatch(/box-shadow:\s*var\(--shadow-e0\)/);
    expect(rule).toMatch(
      /margin:\s*var\(--shell-inset\)\s+var\(--shell-inset\)\s+var\(--shell-inset\)\s+0/,
    );
    expect(tokens).toMatch(/'shell-inset':\s*px\(8\)/);
  });

  it('the card goes full-bleed below 1024px (drawer mode)', () => {
    expect(body(".shell[data-mode='drawer']")).toMatch(/--shell-inset:\s*var\(--space-0\)/);
    const rule = body(".shell[data-mode='drawer'] .main");
    expect(rule).toMatch(/margin:\s*0/);
    expect(rule).toMatch(/border-radius:\s*0/);
    expect(rule).toMatch(/box-shadow:\s*none/);
  });

  it('the sidebar sits on the app layer with no border', () => {
    const rule = body('.sidebar');
    expect(rule).toMatch(/background:\s*var\(--bg-sidebar\)/);
    expect(rule).not.toMatch(/\bborder[a-z-]*:/);
  });

  it('nav items use the nav-item height token and the UI weight', () => {
    const rule = body('.search,\n.item');
    expect(rule).toMatch(/min-height:\s*var\(--nav-item-height\)/);
    expect(rule).toMatch(/font-weight:\s*var\(--weight-ui\)/);
    expect(rule).toMatch(/gap:\s*var\(--space-6\)/);
    expect(tokens).toMatch(/'nav-item-height':\s*px\(28\)/);
  });

  it('the current item is a quiet fill, not an accent bar', () => {
    const rule = body(".item[aria-current='page']");
    expect(rule).toMatch(/background:\s*var\(--bg-active\)/);
    expect(rule).not.toMatch(/accent/);
  });

  it('section headers use the label style', () => {
    expect(body('.section')).toMatch(/font-size:\s*var\(--text-label-size\)/);
  });

  it('the header is 44px with a hairline below, inside the card', () => {
    expect(tokens).toMatch(/'header-height':\s*px\(44\)/);
    const rule = body('.header');
    expect(rule).toMatch(/border-bottom:\s*var\(--hairline\)\s+solid\s+var\(--border-hairline\)/);
    expect(rule).toMatch(/background:\s*var\(--bg-panel\)/);
  });
});

describe('shell breadcrumb css', () => {
  it('breadcrumb links inherit colour and have no underline', () => {
    const rule = body('.crumbs a');
    expect(rule).toMatch(/color:\s*inherit/);
    expect(rule).toMatch(/text-decoration:\s*none/);
    expect(body('.crumbs a:hover')).toMatch(/color:\s*var\(--text-primary\)/);
  });
});
