// PLAN-016 S0 (audit row 24). The wrapper draws the one focus ring; the native input must not add
// the global `:focus-visible` outline on top. A bare `.native` rule only ties with it (0,1,0).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/internal/control.module.css', import.meta.url), 'utf8');

describe('control focus ring', () => {
  it('the native input inside a control draws no outline of its own', () => {
    const match = /(?:^|\n)\.native:focus-visible\s*\{([^}]*)\}/.exec(css);
    expect(match?.[1] ?? '').toMatch(/outline:\s*none/);
  });

  it('the wrapper draws the ring with the accent', () => {
    expect(css).toMatch(
      /\.control:has\(\.native:focus-visible\)\s*\{[^}]*outline:[^;]*var\(--accent\)/,
    );
  });
});
