// SPEC-005 AC-11 (tokens only): every `var(--name)` in the web app's and the design system's CSS
// names a design token, a property defined in the same file, or one Radix sets at runtime. An unknown name silently
// falls back to nothing: the S8 axe sweep found the sync inspector's panel with no background
// (`--bg-surface`), so the drawer's backdrop showed through its text (axe color-contrast).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TOKENS = readFileSync(join(ROOT, 'packages/ui/src/styles/tokens.css'), 'utf8');

function definedIn(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] ?? ''));
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** `file: --name` for each reference to a custom property nothing defines. */
function unknownProperties(files: readonly string[], tokens: string): string[] {
  const known = definedIn(tokens);
  return files.flatMap((file) => {
    const css = readFileSync(file, 'utf8');
    const local = definedIn(css);
    return [...css.matchAll(/var\(\s*(--[\w-]+)/g)]
      .map((m) => m[1] ?? '')
      .filter((name) => !known.has(name) && !local.has(name) && !name.startsWith('--radix-'))
      .map((name) => `${file.slice(ROOT.length)}: ${name}`);
  });
}

describe('custom properties in CSS', () => {
  it.each(['apps/web/src', 'packages/ui/src'])(
    'in %s all name a token, a property of the same file, or a Radix variable',
    (dir) => {
      const files = cssFiles(join(ROOT, dir));
      expect(files.length).toBeGreaterThan(0);
      expect(unknownProperties(files, TOKENS)).toEqual([]);
    },
  );
});
