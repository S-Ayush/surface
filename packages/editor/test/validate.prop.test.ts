// PLAN-013 S1: validateDoc accepts every document the schema can build, and refuses a bad part
// anywhere in one with that part's path (SPEC-013 AC-7, E6).
import type { DocNodeJSON } from '@surface/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DocPath } from '../src/schema/index.js';
import { DOC_MESSAGES, schema, validateDoc } from '../src/schema/index.js';
import { doc, propertyOptions } from './support/arbitraries.js';

/** Every node of a document with its path. */
function nodePaths(node: DocNodeJSON, path: DocPath = []): [DocPath, DocNodeJSON][] {
  return [
    [path, node],
    ...(node.content ?? []).flatMap((child, i) => nodePaths(child, [...path, 'content', i])),
  ];
}

/** A copy of `root` with the node at `path` changed by `change`. */
function replaceAt(
  root: DocNodeJSON,
  path: DocPath,
  change: (node: DocNodeJSON) => unknown,
): unknown {
  if (path.length === 0) return change(root);
  const [, index, ...rest] = path;
  return {
    ...root,
    content: (root.content ?? []).map((child, i) =>
      i === index ? replaceAt(child, rest, change) : child,
    ),
  };
}

const badHref = fc.constantFrom(
  'javascript:alert(1)',
  'JAVASCRIPT:x',
  '//evil.example',
  '/x',
  'https://a\u0007b',
);
const badSrc = fc.constantFrom(
  'https://example.com/a.png',
  'data:image/png;base64,AA==',
  'blob:x',
  '/files/x',
);

// Property runs take seconds when the whole gate runs in parallel.
describe('validateDoc (property)', { timeout: 60_000 }, () => {
  it('accepts every generated document and returns what ProseMirror reads from it', () => {
    fc.assert(
      fc.property(doc, (d) => {
        const parsed: unknown = schema.nodeFromJSON(d).toJSON();
        expect(validateDoc(d)).toEqual({ ok: true, doc: parsed });
      }),
      propertyOptions,
    );
  });

  it('refuses an unknown node anywhere, at its path', () => {
    fc.assert(
      fc.property(doc, fc.nat(), (d, pick) => {
        const nodes = nodePaths(d).filter(([path]) => path.length > 0);
        const [path] = nodes[pick % nodes.length] ?? [[]];
        const result = validateDoc(replaceAt(d, path, () => ({ type: 'iframe' })));
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.problems).toContainEqual({
            path: [...path, 'type'],
            message: expect.stringContaining('"iframe"') as unknown,
          });
      }),
      propertyOptions,
    );
  });

  it('refuses a bad link on any text, at the href', () => {
    fc.assert(
      fc.property(doc, fc.nat(), badHref, (d, pick, href) => {
        const texts = nodePaths(d).filter(
          ([, node]) => node.type === 'text' && !(node.marks ?? []).some((m) => m.type === 'code'),
        );
        fc.pre(texts.length > 0);
        const [path] = texts[pick % texts.length] ?? [[]];
        const bad = replaceAt(d, path, (node) => ({
          ...node,
          marks: [{ type: 'link', attrs: { href } }],
        }));
        const result = validateDoc(bad);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.problems).toContainEqual({
            path: [...path, 'marks', 0, 'attrs', 'href'],
            message: DOC_MESSAGES.badLink,
          });
        }
      }),
      propertyOptions,
    );
  });

  it('refuses an image that is not an uploaded file, wherever a block can go', () => {
    fc.assert(
      fc.property(doc, fc.nat(), badSrc, (d, pick, src) => {
        const blocks = nodePaths(d).filter(
          ([path, node]) => path.length > 0 && node.type === 'paragraph',
        );
        fc.pre(blocks.length > 0);
        const [path] = blocks[pick % blocks.length] ?? [[]];
        const result = validateDoc(
          replaceAt(d, path, () => ({ type: 'image', attrs: { src, alt: null } })),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.problems).toContainEqual({
            path: [...path, 'attrs', 'src'],
            message: DOC_MESSAGES.badImage,
          });
        }
      }),
      propertyOptions,
    );
  });
});
