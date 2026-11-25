// PLAN-016 S0. jsdom does not compute styles from CSS Modules, so these read the source text.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/shell/Shell.module.css', import.meta.url), 'utf8');

function body(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? '';
}

describe('shell breadcrumb css', () => {
  it('breadcrumb links inherit colour and have no underline', () => {
    const rule = body('.crumbs a');
    expect(rule).toMatch(/color:\s*inherit/);
    expect(rule).toMatch(/text-decoration:\s*none/);
    expect(body('.crumbs a:hover')).toMatch(/color:\s*var\(--text-primary\)/);
  });
});
