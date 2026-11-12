// PLAN-013 S1 review: input built to be slow or deep stays bounded. Emphasis repair takes a
// bounded number of passes (B1), and nesting deeper than markdown-it's default 20 levels is read
// in full, so a too-deep text is refused by validateDoc instead of silently cut (M1).
import type { DocMarkJSON, DocNodeJSON } from '@surface/domain';
import { DOC_MAX_BYTES, docJsonBytes } from '@surface/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { EMPHASIS_PASSES, MAX_EMPHASIS_PASSES } from '../src/schema/normalize.js';
import {
  DOC_MESSAGES,
  docToMarkdown,
  docToText,
  markdownToDoc,
  normalize,
  validateDoc,
} from '../src/schema/index.js';

const bold: DocMarkJSON = { type: 'bold' };
const text = (value: string, ...marks: DocMarkJSON[]): DocNodeJSON =>
  marks.length > 0 ? { type: 'text', text: value, marks } : { type: 'text', text: value };
const p = (...content: DocNodeJSON[]): DocNodeJSON => ({ type: 'paragraph', content });
const doc = (...content: DocNodeJSON[]): DocNodeJSON => ({ type: 'doc', content });

describe('emphasis repair (B1)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    EMPHASIS_PASSES.max = 0;
  });

  it('reads 50 KB of emphasis that pairs up badly in a bounded number of passes', () => {
    const md = '***a**b*'.repeat(6400);
    expect(md.length).toBe(51_200);
    const d = markdownToDoc(md);
    expect(EMPHASIS_PASSES.max).toBeLessThanOrEqual(MAX_EMPHASIS_PASSES);
    expect(validateDoc(d)).toMatchObject({ ok: true });
    expect(docToText(d).replaceAll(/[ab*]/g, '')).toBe('');
    // Idempotent, and a fixed point of the round trip.
    expect(normalize(d)).toEqual(d);
    expect(markdownToDoc(docToMarkdown(d))).toEqual(d);
  });

  it('repairs a 200 KB document whose every bold run fails in one pass', () => {
    // `**a.**b`: each closing `**` follows punctuation and precedes a letter, so none closes.
    const content: DocNodeJSON[] = [];
    for (let i = 0; i < 2440; i++) content.push(text('xa.', bold), text('b '));
    const d = doc(p(...content));
    expect(docJsonBytes(d)).toBeGreaterThan(DOC_MAX_BYTES.description * 0.95);
    expect(docJsonBytes(d)).toBeLessThanOrEqual(DOC_MAX_BYTES.description);
    const once = normalize(d);
    // One pass finds every failing delimiter, a second confirms.
    expect(EMPHASIS_PASSES.max).toBeLessThanOrEqual(2);
    expect(once.content?.[0]?.content?.slice(0, 2)).toEqual([text('xa', bold), text('.b ')]);
    expect(normalize(once)).toEqual(once);
    expect(markdownToDoc(docToMarkdown(once))).toEqual(once);
  });

  it('strips emphasis from a block that still fails after the pass limit, the same way twice', () => {
    // Delimiters that flank correctly but pair up differently (CommonMark's "rule of 3") leave
    // text that reads back shifted, so each pass repairs only the first difference: 20 of
    // them reach the limit.
    const d = markdownToDoc('***a**b*'.repeat(20));
    expect(EMPHASIS_PASSES.max).toBe(MAX_EMPHASIS_PASSES);
    const marks = (d.content ?? []).flatMap((block) =>
      (block.content ?? []).flatMap((node) => node.marks ?? []),
    );
    expect(marks).toEqual([]);
    expect(normalize(d)).toEqual(d);
    expect(markdownToDoc(docToMarkdown(d))).toEqual(d);
  });
});

/** `depth` block quotes around one paragraph. */
function quotes(depth: number, inner: DocNodeJSON): DocNodeJSON {
  let node = inner;
  for (let i = 0; i < depth; i++) node = { type: 'blockquote', content: [node] };
  return node;
}

/** `depth` bullet lists, each item holding the next list, around one paragraph. */
function lists(depth: number, inner: DocNodeJSON): DocNodeJSON {
  let node = inner;
  for (let i = 0; i < depth; i++) {
    node = {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [p(text(`level ${depth - i}`)), node] }],
    };
  }
  return node;
}

describe('deep nesting (M1)', () => {
  it('keeps 30 nested block quotes through a round trip', () => {
    const d = doc(quotes(30, p(text('deep'))));
    expect(validateDoc(d)).toMatchObject({ ok: true });
    expect(markdownToDoc(docToMarkdown(d))).toEqual(d);
    expect(docToText(markdownToDoc(`${'> '.repeat(30)}deep`))).toBe('deep');
  });

  it('keeps a list nested 30 levels through a round trip', () => {
    const d = doc(lists(30, p(text('innermost'))));
    expect(validateDoc(d)).toMatchObject({ ok: true });
    expect(markdownToDoc(docToMarkdown(d))).toEqual(d);
  });

  it('reads text nested deeper than 64 levels in full, so validateDoc refuses it', () => {
    const d = markdownToDoc(`${'> '.repeat(80)}too deep`);
    expect(docToText(d)).toBe('too deep');
    expect(validateDoc(d)).toMatchObject({
      ok: false,
      problems: [{ message: DOC_MESSAGES.tooDeep }],
    });
  });
});
