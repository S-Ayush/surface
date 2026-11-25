// PLAN-016 S1 (audit row 38): browsers do not inherit the font into form controls.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const base = await readFile(new URL('../src/styles/base.css', import.meta.url), 'utf8');

describe('base.css', () => {
  it('buttons and inputs inherit font', () => {
    const rule = /(?:^|\n)button,\s*input,\s*select,\s*textarea\s*\{([^}]*)\}/.exec(base);
    expect(rule, 'a rule for button, input, select, textarea').not.toBeNull();
    expect(rule?.[1]).toMatch(/font:\s*inherit;/);
    expect(rule?.[1]).toMatch(/letter-spacing:\s*inherit;/);
  });
});
