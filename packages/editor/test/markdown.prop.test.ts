// PLAN-013 S1: the Markdown round trip (SPEC-013 AC-8, AC-25, E7).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  docToMarkdown,
  docToText,
  markdownToDoc,
  normalize,
  validateDoc,
} from '../src/schema/index.js';
import { doc, markdown, propertyOptions } from './support/arbitraries.js';

// Property runs take seconds when the whole gate runs in parallel.
describe('Markdown round trip (AC-8)', { timeout: 60_000 }, () => {
  it('every generated document is valid, so the properties cover valid documents', () => {
    fc.assert(
      fc.property(doc, (d) => {
        expect(validateDoc(d)).toMatchObject({ ok: true });
      }),
      propertyOptions,
    );
  });

  it('reads back what it writes: markdownToDoc(docToMarkdown(d)) equals normalize(d)', () => {
    fc.assert(
      fc.property(doc, (d) => {
        expect(markdownToDoc(docToMarkdown(d))).toEqual(normalize(d));
      }),
      { ...propertyOptions, numRuns: 1000 },
    );
  });

  it('normalize is idempotent and gives a valid document', () => {
    fc.assert(
      fc.property(doc, (d) => {
        const once = normalize(d);
        expect(normalize(once)).toEqual(once);
        expect(validateDoc(once)).toEqual({ ok: true, doc: once });
      }),
      propertyOptions,
    );
  });

  it('reaches a fixed point after one pass for any Markdown', () => {
    fc.assert(
      fc.property(markdown, (md) => {
        const md1 = docToMarkdown(markdownToDoc(md));
        expect(docToMarkdown(markdownToDoc(md1))).toBe(md1);
        expect(validateDoc(markdownToDoc(md))).toMatchObject({ ok: true });
      }),
      { ...propertyOptions, numRuns: 1000 },
    );
  });

  it('extracts the same text from the same document every time', () => {
    fc.assert(
      fc.property(doc, (d) => {
        // A stored copy (through JSON, as the database returns it) gives the same text.
        const stored = validateDoc(JSON.parse(JSON.stringify(d)));
        expect(stored.ok).toBe(true);
        if (stored.ok) expect(docToText(stored.doc)).toBe(docToText(d));
        expect(docToText(d)).toBe(docToText(d));
      }),
      propertyOptions,
    );
  });
});

describe('underline (AC-25)', () => {
  it('is valid, dropped from Markdown and removed by normalize, keeping the text', () => {
    const d = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'under', marks: [{ type: 'underline' }] },
            { type: 'text', text: 'both', marks: [{ type: 'bold' }, { type: 'underline' }] },
          ],
        },
      ],
    };
    expect(validateDoc(d).ok).toBe(true);
    expect(docToMarkdown(d)).toBe('under**both**');
    expect(normalize(d)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'under' },
            { type: 'text', text: 'both', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    });
    expect(markdownToDoc(docToMarkdown(d))).toEqual(normalize(d));
  });
});
