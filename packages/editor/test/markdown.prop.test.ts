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
import type { DocNodeJSON } from '@surface/domain';
import { deepDoc, doc, markdown, nestedEmphasis, propertyOptions } from './support/arbitraries.js';

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

/** A character of inline content, with the marks normalize must never change. */
type Unit = { readonly ch: string; readonly code: boolean; readonly href: string | null } | 'break';

const NEWLINES = /\r\n?|\n/g;

const isLineSpace = (unit: Unit | undefined): boolean =>
  unit !== undefined && unit !== 'break' && !unit.code && (unit.ch === ' ' || unit.ch === '\t');

const isEdge = (unit: Unit | undefined): boolean =>
  unit !== undefined && (unit === 'break' || (!unit.code && /^\s$/u.test(unit.ch)));

/** Adjacent text with equal marks as one node, as the schema reads it (`\r` + `\n` is one CRLF). */
function mergeText(content: readonly DocNodeJSON[]): DocNodeJSON[] {
  const key = (node: DocNodeJSON) =>
    JSON.stringify(
      (node.marks ?? []).map((mark) => [mark.type, mark.attrs?.['href'] ?? null]).sort(),
    );
  const merged: DocNodeJSON[] = [];
  for (const node of content) {
    const last = merged.at(-1);
    if (node.type === 'text' && last?.type === 'text' && key(last) === key(node)) {
      merged[merged.length - 1] = { ...last, text: `${last.text ?? ''}${node.text ?? ''}` };
    } else merged.push(node);
  }
  return merged;
}

/** Inline content as units: as written, or with the SPEC-013 §4.4 whitespace rules applied. */
function units(content: readonly DocNodeJSON[], heading: boolean, clean: boolean): Unit[] {
  const out: Unit[] = [];
  for (const node of mergeText(content)) {
    if (node.type === 'hardBreak') {
      out.push(heading && clean ? { ch: ' ', code: false, href: null } : 'break');
      continue;
    }
    const marks = node.marks ?? [];
    const code = marks.some((mark) => mark.type === 'code');
    const link = marks.find((mark) => mark.type === 'link')?.attrs?.['href'];
    const href = typeof link === 'string' ? link : null;
    let value = node.type === 'file' ? `[${String(node.attrs?.['name'])}]` : (node.text ?? '');
    if (clean) value = value.replace(NEWLINES, ' ');
    for (const ch of value) out.push({ ch, code, href });
  }
  if (!clean) return out;
  // Spaces and tabs that start a line after a hard break go (Markdown drops them), then
  // whitespace and hard breaks at the edges of the block.
  const kept: Unit[] = [];
  let lineStart = false;
  for (const unit of out) {
    if (lineStart && isLineSpace(unit)) continue;
    lineStart = unit === 'break';
    kept.push(unit);
  }
  while (isEdge(kept[0])) kept.shift();
  while (isEdge(kept.at(-1))) kept.pop();
  return kept;
}

/** Every block's text in order (empty blocks left out), as written or with the §4.4 rules. */
function blockTexts(node: DocNodeJSON, clean: boolean): string[] {
  const show = (list: Unit[]) =>
    list.map((unit) => (unit === 'break' ? '<br>' : JSON.stringify(unit))).join('');
  switch (node.type) {
    case 'paragraph':
    case 'heading': {
      const list = units(node.content ?? [], node.type === 'heading', clean);
      return list.length > 0 ? [show(list)] : [];
    }
    case 'codeBlock': {
      const code = (node.content ?? []).map((child) => child.text ?? '').join('');
      const text = clean ? code.replace(/\r\n?/g, '\n') : code;
      return text === '' ? [] : [`code:${text}`];
    }
    case 'image': {
      const alt = node.attrs?.['alt'];
      if (typeof alt !== 'string' || alt === '') return [];
      return [`alt:${clean ? alt.replace(NEWLINES, ' ') : alt}`];
    }
    default:
      return (node.content ?? []).flatMap((child) => blockTexts(child, clean));
  }
}

describe('normalize keeps what Markdown can write (M3)', { timeout: 60_000 }, () => {
  it('changes plain text, links and code only by the whitespace and line-break rules', () => {
    fc.assert(
      fc.property(doc, (d) => {
        expect(blockTexts(normalize(d), false)).toEqual(blockTexts(d, true));
      }),
      propertyOptions,
    );
  });

  it('keeps properly nested emphasis whose runs start and end on letters or digits', () => {
    fc.assert(
      fc.property(nestedEmphasis, (d) => {
        const valid = validateDoc(d);
        expect(valid.ok).toBe(true);
        if (!valid.ok) return;
        expect(normalize(d)).toEqual(valid.doc);
        expect(markdownToDoc(docToMarkdown(d))).toEqual(valid.doc);
      }),
      { ...propertyOptions, numRuns: 1000 },
    );
  });

  it("round-trips nesting deeper than markdown-it's default limit of 20 levels (M1)", () => {
    fc.assert(
      fc.property(deepDoc, (d) => {
        expect(validateDoc(d)).toMatchObject({ ok: true });
        expect(markdownToDoc(docToMarkdown(d))).toEqual(normalize(d));
      }),
      propertyOptions,
    );
  });
});
