// PLAN-013 S1: validateDoc accepts the schema's documents and refuses anything else, with the
// JSON path of the problem (SPEC-013 AC-7, E6).
import { EMPTY_DOC } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import type { DocProblem } from '../src/schema/index.js';
import { DOC_MESSAGES, isAllowedHref, validateDoc } from '../src/schema/index.js';
import { BAD_HREFS, GOOD_HREFS } from './support/fixtures.js';

const FILE = '/files/0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b';

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const linked = (href: unknown) =>
  doc(paragraph({ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }));

function problems(json: unknown): readonly DocProblem[] {
  const result = validateDoc(json);
  if (result.ok) throw new Error('expected the document to be refused');
  return result.problems;
}

describe('validateDoc accepts', () => {
  it('the empty document', () => {
    expect(validateDoc(EMPTY_DOC)).toEqual({ ok: true, doc: EMPTY_DOC });
  });

  it('every node and mark of the schema, headings 1–4 and underline included', () => {
    const everything = doc(
      ...[1, 2, 3, 4].map((level) => ({
        type: 'heading',
        attrs: { level },
        content: [{ type: 'text', text: `H${level}` }],
      })),
      paragraph(
        {
          type: 'text',
          text: 'all',
          marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }, { type: 'strike' }],
        },
        { type: 'hardBreak' },
        { type: 'text', text: 'code', marks: [{ type: 'code' }] },
        {
          type: 'text',
          text: 'link',
          marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
        },
        { type: 'file', attrs: { src: FILE, name: 'spec.pdf' } },
      ),
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph()] }] },
      {
        type: 'orderedList',
        content: [
          {
            type: 'listItem',
            content: [paragraph(), { type: 'blockquote', content: [paragraph()] }],
          },
        ],
      },
      {
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph()] }],
      },
      {
        type: 'codeBlock',
        attrs: { language: 'typescript' },
        content: [{ type: 'text', text: 'let x = 1;' }],
      },
      { type: 'horizontalRule' },
      { type: 'image', attrs: { src: FILE, alt: 'A cat' } },
    );
    expect(validateDoc(everything).ok).toBe(true);
  });

  it('returns the canonical form: marks in schema order, defaults filled in', () => {
    const result = validateDoc(
      doc(
        paragraph({
          type: 'text',
          text: 'x',
          marks: [{ type: 'italic' }, { type: 'link', attrs: { href: 'mailto:a@b.co' } }],
        }),
        { type: 'codeBlock' },
      ),
    );
    expect(result).toEqual({
      ok: true,
      doc: doc(
        paragraph({
          type: 'text',
          text: 'x',
          marks: [{ type: 'link', attrs: { href: 'mailto:a@b.co' } }, { type: 'italic' }],
        }),
        { type: 'codeBlock', attrs: { language: null } },
      ),
    });
  });

  it.each(GOOD_HREFS)('the link %j', (href) => {
    expect(validateDoc(linked(href)).ok).toBe(true);
  });
});

describe('validateDoc refuses, with the path of the problem', () => {
  it('a root that is not a document', () => {
    expect(problems(null)).toEqual([{ path: [], message: DOC_MESSAGES.notADoc }]);
    expect(problems('# Markdown')).toEqual([{ path: [], message: DOC_MESSAGES.notADoc }]);
    expect(problems(paragraph())).toEqual([{ path: ['type'], message: DOC_MESSAGES.notADoc }]);
  });

  it('an unknown node (E6)', () => {
    expect(problems(doc(paragraph(), { type: 'table', content: [] }))).toEqual([
      { path: ['content', 1, 'type'], message: expect.stringContaining('"table"') as unknown },
    ]);
  });

  it('an unknown mark', () => {
    const json = doc(paragraph({ type: 'text', text: 'x', marks: [{ type: 'highlight' }] }));
    expect(problems(json)).toEqual([
      {
        path: ['content', 0, 'content', 0, 'marks', 0, 'type'],
        message: expect.stringContaining('"highlight"') as unknown,
      },
    ]);
  });

  it.each(BAD_HREFS.map((href) => [href]))(
    'the link %j (mixed case, control characters, relative and protocol-relative included)',
    (href) => {
      expect(problems(linked(href))).toEqual([
        {
          path: ['content', 0, 'content', 0, 'marks', 0, 'attrs', 'href'],
          message: DOC_MESSAGES.badLink,
        },
      ]);
    },
  );

  it('a link without an href', () => {
    const json = doc(paragraph({ type: 'text', text: 'x', marks: [{ type: 'link' }] }));
    expect(problems(json)).toEqual([
      {
        path: ['content', 0, 'content', 0, 'marks', 0, 'attrs', 'href'],
        message: DOC_MESSAGES.badLink,
      },
    ]);
  });

  it.each([
    ['https://example.com/cat.png'],
    ['data:image/png;base64,iVBORw0KGgo='],
    ['blob:https://surface.example/0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b'],
    ['//example.com/cat.png'],
    ['/files/not-a-uuid'],
    ['/files/0190F3B2-7C1A-7D4E-9A1B-2C3D4E5F6A7B'],
    ['/files/0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b/../secret'],
    [null],
  ])('an image with src %j: external, data: and blob: images', (src) => {
    expect(problems(doc({ type: 'image', attrs: { src, alt: null } }))).toEqual([
      { path: ['content', 0, 'attrs', 'src'], message: DOC_MESSAGES.badImage },
    ]);
  });

  it('a file chip that is not an uploaded file, or has no name', () => {
    const json = doc(
      paragraph(
        { type: 'file', attrs: { src: 'https://example.com/a.pdf', name: 'a.pdf' } },
        { type: 'file', attrs: { src: FILE, name: '' } },
        { type: 'file', attrs: { src: FILE } },
      ),
    );
    expect(problems(json)).toEqual([
      { path: ['content', 0, 'content', 0, 'attrs', 'src'], message: DOC_MESSAGES.badFile },
      {
        path: ['content', 0, 'content', 1, 'attrs', 'name'],
        message: expect.any(String) as unknown,
      },
      {
        path: ['content', 0, 'content', 2, 'attrs', 'name'],
        message: expect.any(String) as unknown,
      },
    ]);
  });

  it('more than 50 file references', () => {
    const images = Array.from({ length: 51 }, () => ({
      type: 'image',
      attrs: { src: FILE, alt: null },
    }));
    expect(problems(doc(...images))).toEqual([{ path: [], message: DOC_MESSAGES.tooManyFiles }]);
    expect(validateDoc(doc(...images.slice(1))).ok).toBe(true);
  });

  it('an attribute the schema does not have, including prototype names', () => {
    const json = doc(
      { type: 'heading', attrs: { level: 1, id: 'x' } },
      { type: 'image', attrs: { src: FILE, alt: null, constructor: 'x' } },
    );
    expect(problems(json).map((problem) => problem.path)).toEqual([
      ['content', 0, 'attrs', 'id'],
      ['content', 1, 'attrs', 'constructor'],
    ]);
  });

  it('a bad attribute value', () => {
    const json = doc(
      { type: 'heading', attrs: { level: 5 } },
      {
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: 'yes' }, content: [paragraph()] }],
      },
      { type: 'codeBlock', attrs: { language: 'java script' } },
    );
    expect(problems(json).map((problem) => problem.path)).toEqual([
      ['content', 0, 'attrs', 'level'],
      ['content', 1, 'content', 0, 'attrs', 'checked'],
      ['content', 2, 'attrs', 'language'],
    ]);
  });

  it('content a node may not hold', () => {
    const json = doc(
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'heading', attrs: { level: 1 } }] }],
      },
      { type: 'codeBlock', content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }] },
      paragraph({ type: 'paragraph' }),
    );
    expect(problems(json).map((problem) => problem.path)).toEqual([
      ['content', 0, 'content', 0],
      ['content', 1],
      ['content', 2],
    ]);
    expect(problems(doc()).map((problem) => problem.path)).toEqual([[]]);
  });

  it('inline code combined with another mark, and a mark given twice', () => {
    const json = doc(
      paragraph(
        { type: 'text', text: 'a', marks: [{ type: 'code' }, { type: 'bold' }] },
        { type: 'text', text: 'b', marks: [{ type: 'bold' }, { type: 'bold' }] },
      ),
    );
    expect(problems(json)).toEqual([
      { path: ['content', 0, 'content', 0, 'marks'], message: DOC_MESSAGES.codeWithMarks },
      { path: ['content', 0, 'content', 1, 'marks'], message: expect.any(String) as unknown },
    ]);
  });

  it('empty text, unknown fields and wrong types', () => {
    const json = {
      type: 'doc',
      extra: 1,
      content: [
        paragraph({ type: 'text', text: '' }, { type: 'hardBreak', text: 'x' }, 'text'),
        { type: 'paragraph', content: 'x' },
      ],
    };
    expect(problems(json).map((problem) => problem.path)).toEqual([
      ['extra'],
      ['content', 0, 'content', 0],
      ['content', 0, 'content', 1, 'text'],
      ['content', 0, 'content', 2],
      ['content', 1, 'content'],
    ]);
  });

  it('documents nested deeper than 64 levels', () => {
    let node: unknown = paragraph();
    for (let i = 0; i < 70; i++) node = { type: 'blockquote', content: [node] };
    expect(problems(doc(node))[0]?.message).toBe(DOC_MESSAGES.tooDeep);
  });

  it('at most 20 problems, so a huge bad document gives a bounded answer', () => {
    const json = doc(...Array.from({ length: 100 }, () => ({ type: 'table' })));
    expect(problems(json)).toHaveLength(20);
  });

  it('NUL characters and lone surrogates in text and attributes, which Postgres refuses (E6)', () => {
    const json = doc(
      paragraph(
        { type: 'text', text: 'a\0b' },
        { type: 'text', text: 'broken \uD800 pair', marks: [{ type: 'bold' }] },
        { type: 'file', attrs: { src: FILE, name: 'name\uDC00.pdf' } },
        {
          type: 'text',
          text: 'link',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/\uD83D' } }],
        },
      ),
      { type: 'image', attrs: { src: FILE, alt: 'alt\0' } },
      { type: 'codeBlock', content: [{ type: 'text', text: 'code\0' }] },
    );
    expect(problems(json)).toEqual([
      { path: ['content', 0, 'content', 0, 'text'], message: DOC_MESSAGES.brokenText },
      { path: ['content', 0, 'content', 1, 'text'], message: DOC_MESSAGES.brokenText },
      { path: ['content', 0, 'content', 2, 'attrs', 'name'], message: DOC_MESSAGES.brokenText },
      {
        path: ['content', 0, 'content', 3, 'marks', 0, 'attrs', 'href'],
        message: DOC_MESSAGES.brokenText,
      },
      { path: ['content', 1, 'attrs', 'alt'], message: DOC_MESSAGES.brokenText },
      { path: ['content', 2, 'content', 0, 'text'], message: DOC_MESSAGES.brokenText },
    ]);
    // A surrogate pair is one character, not broken.
    expect(validateDoc(doc(paragraph({ type: 'text', text: '👍' }))).ok).toBe(true);
  });

  it('echoes at most 40 characters of a name it does not know', () => {
    const long = 'x'.repeat(500);
    for (const message of problems(
      doc({ type: long }, paragraph({ type: 'text', text: 'a', marks: [{ type: long }] }), {
        type: 'heading',
        attrs: { [long]: 1 },
      }),
    ).map((problem) => problem.message)) {
      expect(message).not.toContain('x'.repeat(41));
      expect(message).toContain('x'.repeat(40));
    }
  });
});

describe('isAllowedHref', () => {
  it('is the link rule shared with Markdown import, paste and DocView', () => {
    expect(isAllowedHref('https://example.com')).toBe(true);
    expect(isAllowedHref('javascript:alert(1)')).toBe(false);
  });
});
