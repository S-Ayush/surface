// @vitest-environment node
// PLAN-013 S1: the headless entry runs in plain Node with no DOM globals (SPEC-013 AC-10), from
// source and as built for the server image (PLAN-013 risk: the schema entry fails in the image).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as entry from '../src/schema/index.js';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const BUILT_ENTRY = fileURLToPath(new URL('../dist/schema/index.js', import.meta.url));

const MARKDOWN = '# Title\n\nSome **bold** text and a [link](https://example.com).';
const EXPECTED = {
  valid: true,
  text: 'Title\nSome bold text and a link.',
  markdown: MARKDOWN,
  nodes: 15, // the 14 of SPEC-013 §4.4, and text
};

describe('@surface/editor/schema in Node', () => {
  it('imports and runs from source with no DOM globals', () => {
    expect(typeof globalThis.window).toBe('undefined');
    expect(typeof globalThis.document).toBe('undefined');
    const doc = entry.markdownToDoc(MARKDOWN);
    expect({
      valid: entry.validateDoc(doc).ok,
      text: entry.docToText(doc),
      markdown: entry.docToMarkdown(doc),
      nodes: Object.keys(entry.schema.nodes).length,
    }).toEqual(EXPECTED);
  });

  it('imports and runs as built, by package name, in a plain Node process like the server', () => {
    // `pnpm test` builds first (packages/editor/turbo.json). Running Vitest directly needs
    // `pnpm --filter @surface/editor build`.
    expect(existsSync(BUILT_ENTRY), `${BUILT_ENTRY} is missing: build the package first`).toBe(
      true,
    );
    // No --conditions flag: Node resolves `@surface/editor/schema` to dist/, as in the image.
    const script = `
      const entry = await import('@surface/editor/schema');
      const doc = entry.markdownToDoc(${JSON.stringify(MARKDOWN)});
      console.log(JSON.stringify({
        dom: typeof window !== 'undefined' || typeof document !== 'undefined',
        valid: entry.validateDoc(doc).ok,
        text: entry.docToText(doc),
        markdown: entry.docToMarkdown(doc),
        nodes: Object.keys(entry.schema.nodes).length,
      }));`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
    });
    expect(JSON.parse(output)).toEqual({ dom: false, ...EXPECTED });
  });
});
