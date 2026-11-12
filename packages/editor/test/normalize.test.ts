// PLAN-013 S1: the normalize rules of SPEC-013 §4.4, one example each. The round-trip and
// idempotence properties are in markdown.prop.test.ts.
import type { DocMarkJSON, DocNodeJSON } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import { normalize } from '../src/schema/index.js';

const doc = (...content: DocNodeJSON[]): DocNodeJSON => ({ type: 'doc', content });
const p = (...content: DocNodeJSON[]): DocNodeJSON =>
  content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
const text = (value: string, ...marks: DocMarkJSON[]): DocNodeJSON =>
  marks.length > 0 ? { type: 'text', text: value, marks } : { type: 'text', text: value };
const br: DocNodeJSON = { type: 'hardBreak' };
const bold: DocMarkJSON = { type: 'bold' };
const item = (...content: DocNodeJSON[]): DocNodeJSON => ({ type: 'listItem', content });

describe('normalize', () => {
  it('removes underline and merges text with equal marks', () => {
    expect(normalize(doc(p(text('a', { type: 'underline' }, bold), text('b', bold))))).toEqual(
      doc(p(text('ab', bold))),
    );
  });

  it('collapses runs of empty paragraphs and removes them at the edges', () => {
    expect(normalize(doc(p(), p(text('a')), p(), p(), p(text('b')), p()))).toEqual(
      doc(p(text('a')), p(), p(text('b'))),
    );
    expect(normalize(doc(p(), p()))).toEqual(doc(p()));
  });

  it('trims text blocks and the spaces and tabs that start a line, and drops edge hard breaks', () => {
    expect(normalize(doc(p(br, text('  a  '), br, text(' \tb '), br)))).toEqual(
      doc(p(text('a  '), br, text('b'))),
    );
  });

  it('keeps a no-break or ideographic space after a hard break, which Markdown keeps too', () => {
    const d = doc(p(text('a'), br, text('\u00a0b'), br, text('\u3000c')));
    expect(normalize(d)).toEqual(d);
  });

  it('keeps spaces inside inline code at the start of a line', () => {
    const d = doc(p(text(' a', { type: 'code' }), br, text('  ', { type: 'code' })));
    expect(normalize(d)).toEqual(d);
  });

  it('turns a hard break in a heading into a space, and line breaks in text into spaces', () => {
    expect(
      normalize(
        doc({ type: 'heading', attrs: { level: 2 }, content: [text('a'), br, text('b\nc')] }),
      ),
    ).toEqual(doc({ type: 'heading', attrs: { level: 2 }, content: [text('a b c')] }));
  });

  it('merges adjacent lists of the same kind', () => {
    const list = (value: string) => ({ type: 'bulletList', content: [item(p(text(value)))] });
    expect(normalize(doc(list('a'), list('b')))).toEqual(
      doc({ type: 'bulletList', content: [item(p(text('a'))), item(p(text('b')))] }),
    );
  });

  it('starts a list item with an empty paragraph only when its first block is not a paragraph', () => {
    const heading: DocNodeJSON = { type: 'heading', attrs: { level: 1 }, content: [text('h')] };
    const list = (...content: DocNodeJSON[]): DocNodeJSON =>
      doc({ type: 'bulletList', content: [item(...content)] });
    expect(normalize(list(p(), p(text('a'))))).toEqual(list(p(text('a'))));
    expect(normalize(list(p(), heading))).toEqual(list(p(), heading));
  });

  it('removes emphasis Markdown cannot write there, from the character next to the delimiter', () => {
    // `**a.**b`: the closing `**` follows punctuation and precedes a letter, so it can't close.
    expect(normalize(doc(p(text('a.', bold), text('b'))))).toEqual(
      doc(p(text('a', bold), text('.b'))),
    );
    // `** a**`: emphasis can't start with a space.
    expect(normalize(doc(p(text('x'), text(' a', bold))))).toEqual(
      doc(p(text('x '), text('a', bold))),
    );
    // `**Note:** text` is fine: a space follows the closing delimiter.
    const note = doc(p(text('Note:', bold), text(' text')));
    expect(normalize(note)).toEqual(note);
  });

  it('cleans image alt text and file names', () => {
    const src = '/files/0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b';
    expect(
      normalize(
        doc(
          { type: 'image', attrs: { src, alt: '' } },
          p({ type: 'file', attrs: { src, name: 'a\nb' }, marks: [bold] }),
        ),
      ),
    ).toEqual(
      doc(
        { type: 'image', attrs: { src, alt: null } },
        p({ type: 'file', attrs: { src, name: 'a b' } }),
      ),
    );
  });

  it('throws on an invalid document, attributes and link rule included', () => {
    expect(() => normalize({ type: 'doc', content: [{ type: 'table' }] })).toThrow();
    const link = { type: 'link', attrs: { href: 'javascript:alert(1)' } };
    expect(() => normalize(doc(p(text('x', link))))).toThrow(/link/);
    const code = { type: 'codeBlock', attrs: { language: 'js`\n# injected' } };
    expect(() => normalize(doc(code))).toThrow(/language/);
    expect(() => normalize(doc(p(text('a\0'))))).toThrow(/NUL/);
  });
});
