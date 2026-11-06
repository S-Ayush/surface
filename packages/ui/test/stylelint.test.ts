// AC-11 (lint part): the Stylelint rule rejects hard-coded colours and raw px in component CSS.
import { fileURLToPath } from 'node:url';
import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const COMPONENT_CSS = `${ROOT}packages/ui/src/Example.module.css`;

async function lint(code: string, codeFilename = COMPONENT_CSS): Promise<string[]> {
  const { results } = await stylelint.lint({
    code,
    codeFilename,
    configFile: `${ROOT}stylelint.config.js`,
  });
  return results.flatMap((r) => r.warnings.map((w) => w.rule));
}

describe('stylelint token rule', () => {
  it.each([
    ['a hex colour', '.a { color: #fff; }', 'color-no-hex'],
    ['a named colour', '.a { background: white; }', 'color-named'],
    ['rgb()', '.a { color: rgb(0 0 0 / 0.5); }', 'function-disallowed-list'],
    ['hsl()', '.a { border-color: hsl(0 0% 0%); }', 'function-disallowed-list'],
    ['raw px', '.a { padding: 8px; }', 'unit-disallowed-list'],
    ['a physical unit', '.a { margin: 6pt; }', 'unit-disallowed-list'],
    [
      'raw px in a shorthand',
      '.a { border: 1px solid var(--border-default); }',
      'unit-disallowed-list',
    ],
  ])('rejects %s in component CSS', async (_, code, rule) => {
    expect(await lint(code)).toContain(rule);
  });

  it('accepts token-only CSS, keywords and px in media queries', async () => {
    const code = `
      .a {
        color: var(--text-primary);
        background: transparent;
        border: var(--border-width) solid currentcolor;
        padding: var(--space-4) 0;
        line-height: 1.5;
      }
      @media (max-width: 767px) { .a { padding: 0; } }
    `;
    expect(await lint(code)).toEqual([]);
  });

  it('ignores the generated token file, the one place raw values live', async () => {
    const { results } = await stylelint.lint({
      code: ':root { --gray-1: #FFFFFF; --space-4: 4px; }',
      codeFilename: `${ROOT}packages/ui/src/styles/tokens.css`,
      configFile: `${ROOT}stylelint.config.js`,
    });
    expect(results.every((r) => r.ignored === true || r.warnings.length === 0)).toBe(true);
  });
});
