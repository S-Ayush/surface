// PLAN-016 S2 (design-system §2.6): an overlay keyframe moves an element only through the
// `--motion-shift` and `--motion-scale` tokens, which reduced motion sets to 0 and 1 so that only
// the opacity change remains. Reads the CSS source; jsdom does not compute CSS Modules.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../src/', import.meta.url);

function cssFiles(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) return cssFiles(url);
    return entry.name.endsWith('.css') ? [url] : [];
  });
}

type Keyframes = { file: string; name: string; body: string; source: string };

function keyframesIn(file: URL): Keyframes[] {
  const source = readFileSync(file, 'utf8');
  const found: Keyframes[] = [];
  for (const match of source.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    // Braces nest one level (from/to blocks).
    let depth = 1;
    let end = (match.index ?? 0) + match[0].length;
    while (depth > 0 && end < source.length) {
      if (source[end] === '{') depth++;
      if (source[end] === '}') depth--;
      end++;
    }
    found.push({
      file: file.pathname.split('/src/')[1] ?? file.pathname,
      name: match[1] ?? '',
      body: source.slice((match.index ?? 0) + match[0].length, end - 1),
      source,
    });
  }
  return found;
}

const all = cssFiles(ROOT).flatMap(keyframesIn);

/** A transform value with the token references and the dialog's `-50%` centring taken out. */
function untokenised(body: string): string[] {
  const values = [...body.matchAll(/(?:transform|translate|scale|rotate):\s*([^;]+);/g)].map(
    (m) => m[1] ?? '',
  );
  return values.filter((value) => {
    const bare = value
      .replace(/calc\(-1 \* var\(--motion-shift\)\)/g, '')
      .replace(/var\(--motion-(?:shift|scale)\)/g, '')
      .replace(/translate\(-50%/g, 'translate(')
      .replace(/translateX\(-50%\)/g, '');
    // Anything left with a number that is not 0 or 1 moves by a literal.
    return /(?<![\w-])-?\d*\.?\d+(?:px|%|rem|em|deg|turn|vw|vh)?(?![\w-])/.test(
      bare.replace(/(?<![\w.-])[01](?![\w.%])/g, ''),
    );
  });
}

describe('keyframes', () => {
  it('finds the overlay keyframes', () => {
    const names = all.filter((k) => /Dialog|Menu|Popover|Tooltip|Toast/.test(k.file));
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it('keyframes move only through motion tokens', () => {
    for (const keyframes of all) {
      const literals = untokenised(keyframes.body);
      // Spinner and ProgressBar loop indefinitely and have their own reduced-motion rules.
      const looping = /Spinner|ProgressBar/.test(keyframes.file);
      if (looping) {
        expect(keyframes.source, keyframes.file).toMatch(/prefers-reduced-motion/);
        continue;
      }
      expect(literals, `${keyframes.file} @keyframes ${keyframes.name}`).toEqual([]);
    }
  });

  it('every overlay has an exit on --dur-exit and --ease-in that takes no clicks and is shorter than its enter', () => {
    const tokens = readFileSync(new URL('styles/tokens.css', ROOT), 'utf8');
    const ms = (name: string) => Number(new RegExp(`--${name}:\\s*(\\d+)ms`).exec(tokens)?.[1]);
    for (const file of [
      'Dialog/Dialog.module.css',
      'Menu/Menu.module.css',
      'Popover/Popover.module.css',
      'Tooltip/Tooltip.module.css',
      'Toast/Toast.module.css',
    ]) {
      const source = readFileSync(new URL(`components/${file}`, ROOT), 'utf8');
      expect(source, file).toMatch(
        /\[data-state='closed'\]\s*\{\s*animation:\s*[\w-]+\s+var\(--dur-exit\)\s+var\(--ease-in\)[^;]*;\s*pointer-events:\s*none/,
      );
      const enter = /animation:\s*[\w-]+\s+var\(--(dur-\w+)\)\s+var\(--ease-out\)/.exec(source);
      expect(ms('dur-exit'), file).toBeLessThan(ms(enter?.[1] ?? 'dur-fast'));
    }
  });

  it('the discard question has no exit, so nothing can be clicked while it fades', () => {
    const source = readFileSync(new URL('components/Dialog/Dialog.module.css', ROOT), 'utf8');
    expect(source).toMatch(/\.content\.instant\[data-state='closed'\]\s*\{[^}]*animation:\s*none/);
  });
});
