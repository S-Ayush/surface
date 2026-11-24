// SPEC-014 §4.3 (PLAN-014 S4b review): the server stores a saved document pointed at this issue's
// copies (`renameFileSrcs`), and the client finds those renames (`fileSrcRenames`) to adopt them.
import type { DocNodeJSON } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import { fileSrcRenames, renameFileSrcs } from '../src/schema/index.js';

const A = '01940000-0000-7000-8000-00000000000a';
const B = '01940000-0000-7000-8000-00000000000b';
const X = '01940000-0000-7000-8000-0000000000aa';
const Y = '01940000-0000-7000-8000-0000000000bb';

const image = (id: string, alt = 'Screenshot'): DocNodeJSON => ({
  type: 'image',
  attrs: { src: `/files/${id}`, alt },
});
const chip = (id: string): DocNodeJSON => ({
  type: 'paragraph',
  content: [{ type: 'file', attrs: { src: `/files/${id}`, name: 'report.pdf' } }],
});
const text = (value: string): DocNodeJSON => ({
  type: 'paragraph',
  content: [{ type: 'text', text: value }],
});
const docOf = (...nodes: DocNodeJSON[]): DocNodeJSON => ({ type: 'doc', content: nodes });

describe('renameFileSrcs', () => {
  it('points every image and file chip naming a renamed file at its new id, and nothing else', () => {
    const doc = docOf(text(`/files/${A}`), image(A), chip(A), image(B));
    expect(renameFileSrcs(doc, new Map([[A, X]]))).toEqual(
      docOf(text(`/files/${A}`), image(X), chip(X), image(B)),
    );
  });

  it('returns the same document when nothing is renamed', () => {
    const doc = docOf(image(A));
    expect(renameFileSrcs(doc, new Map())).toBe(doc);
  });
});

describe('fileSrcRenames', () => {
  it('finds the renames when only file srcs differ', () => {
    const sent = docOf(text('Before'), image(A), chip(B), image(A));
    const stored = docOf(text('Before'), image(X), chip(Y), image(X));
    expect(fileSrcRenames(sent, stored)).toEqual(
      new Map([
        [A, X],
        [B, Y],
      ]),
    );
  });

  it('is empty for the same document', () => {
    expect(fileSrcRenames(docOf(image(A)), docOf(image(A)))).toEqual(new Map());
  });

  it('is undefined when anything but a src differs', () => {
    expect(fileSrcRenames(docOf(text('a'), image(A)), docOf(text('b'), image(X)))).toBeUndefined();
    expect(fileSrcRenames(docOf(image(A)), docOf(image(X, 'Other')))).toBeUndefined();
    expect(fileSrcRenames(docOf(image(A)), docOf(image(A), image(X)))).toBeUndefined();
  });

  it('is undefined when one id became two', () => {
    expect(fileSrcRenames(docOf(image(A), image(A)), docOf(image(X), image(Y)))).toBeUndefined();
    expect(fileSrcRenames(docOf(image(A), image(A)), docOf(image(A), image(X)))).toBeUndefined();
  });
});
