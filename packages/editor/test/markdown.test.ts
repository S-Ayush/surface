// PLAN-013 S1: Markdown examples (SPEC-013 §4.4 "Markdown", E7): fences, escaping, files and
// images, tables and HTML, links. The properties are in markdown.prop.test.ts.
import type { DocMarkJSON, DocNodeJSON } from '@surface/domain';
import { EMPTY_DOC } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import { docToMarkdown, markdownToDoc } from '../src/schema/index.js';

const ID = '0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b';
const FILE = `/files/${ID}`;

const doc = (...content: DocNodeJSON[]): DocNodeJSON => ({ type: 'doc', content });
const p = (...content: DocNodeJSON[]): DocNodeJSON =>
  content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
const text = (value: string, ...marks: DocMarkJSON[]): DocNodeJSON =>
  marks.length > 0 ? { type: 'text', text: value, marks } : { type: 'text', text: value };
const link = (href: string): DocMarkJSON => ({ type: 'link', attrs: { href } });

/** Markdown → document → Markdown, for examples that are already in written form. */
const roundTrip = (md: string) => docToMarkdown(markdownToDoc(md));

describe('docToMarkdown', () => {
  it('writes the empty document as the empty string, and reads it back', () => {
    expect(docToMarkdown(EMPTY_DOC)).toBe('');
    expect(markdownToDoc('')).toEqual(EMPTY_DOC);
    expect(markdownToDoc('   \n\n')).toEqual(EMPTY_DOC);
  });

  it('fences code with more backticks than any run inside it, keeping the language', () => {
    const code = 'a ``` b\n````\n';
    const d = doc({ type: 'codeBlock', attrs: { language: 'js' }, content: [text(code)] });
    expect(docToMarkdown(d)).toBe(`\`\`\`\`\`js\n${code}\n\`\`\`\`\``);
    expect(markdownToDoc(docToMarkdown(d))).toEqual(d);
  });

  it('escapes text that would read as Markdown', () => {
    const d = doc(
      p(text('# not a heading')),
      p(text('1. not a list, - nor *this*, _that_, ~~this~~ or `code`')),
      p(text('<b>not html</b> &amp; not an entity, [not](a link) ![nor](an image)')),
      p(text('> not a quote')),
    );
    expect(docToMarkdown(d)).toBe(
      [
        '\\# not a heading',
        '1\\. not a list, - nor \\*this\\*, \\_that\\_, \\~\\~this\\~\\~ or \\`code\\`',
        '\\<b>not html\\</b> \\&amp; not an entity, \\[not\\](a link) !\\[nor\\](an image)',
        '\\> not a quote',
      ].join('\n\n'),
    );
    expect(markdownToDoc(docToMarkdown(d))).toEqual(d);
  });

  it('writes images of uploaded files as images and file chips as links to them', () => {
    const d = doc(
      { type: 'image', attrs: { src: FILE, alt: 'A [cat]' } },
      p(text('See '), { type: 'file', attrs: { src: FILE, name: 'spec_v2.pdf' } }),
    );
    expect(docToMarkdown(d)).toBe(`![A \\[cat\\]](${FILE})\n\nSee [spec\\_v2.pdf](${FILE})`);
    expect(markdownToDoc(docToMarkdown(d))).toEqual(d);
  });

  it('drops underline and keeps its text (AC-25)', () => {
    expect(docToMarkdown(doc(p(text('u', { type: 'underline' }))))).toBe('u');
  });

  it('keeps an empty paragraph between blocks, and keeps lists of different kinds apart', () => {
    const item = (value: string) => ({ type: 'listItem', content: [p(text(value))] });
    const task = (value: string) => ({
      type: 'taskItem',
      attrs: { checked: false },
      content: [p(text(value))],
    });
    const d = doc(
      p(text('a')),
      p(),
      p(text('b')),
      { type: 'bulletList', content: [item('x')] },
      { type: 'taskList', content: [task('y')] },
      { type: 'bulletList', content: [item('z')] },
    );
    expect(docToMarkdown(d)).toBe('a\n\n&nbsp;\n\nb\n\n- x\n\n* [ ] y\n\n- z');
    expect(markdownToDoc(docToMarkdown(d))).toEqual(d);
  });

  it('escapes a link destination and keeps it exactly as written', () => {
    const href = 'https://example.com/a_(b)?q=1&amp;x';
    const d = doc(p(text('go', link(href))));
    expect(docToMarkdown(d)).toBe('[go](https://example.com/a_\\(b\\)?q=1\\&amp;x)');
    expect(markdownToDoc(docToMarkdown(d))).toEqual(d);
  });
});

describe('markdownToDoc', () => {
  it('reads CommonMark blocks, GFM task lists and strikethrough', () => {
    const d = markdownToDoc(
      '## Plan\n\n- [ ] write\n- [x] ship\n\n1. one\n2. two\n\n> **Note:** ~~old~~ `new`\n\n---',
    );
    expect(d).toEqual(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [text('Plan')] },
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: false }, content: [p(text('write'))] },
            { type: 'taskItem', attrs: { checked: true }, content: [p(text('ship'))] },
          ],
        },
        {
          type: 'orderedList',
          content: [
            { type: 'listItem', content: [p(text('one'))] },
            { type: 'listItem', content: [p(text('two'))] },
          ],
        },
        {
          type: 'blockquote',
          content: [
            p(
              text('Note:', { type: 'bold' }),
              text(' '),
              text('old', { type: 'strike' }),
              text(' '),
              text('new', { type: 'code' }),
            ),
          ],
        },
        { type: 'horizontalRule' },
      ),
    );
  });

  it('turns headings 5 and 6 into heading 4', () => {
    expect(markdownToDoc('###### Deep')).toEqual(
      doc({ type: 'heading', attrs: { level: 4 }, content: [text('Deep')] }),
    );
  });

  it('turns tables and raw HTML into plain text (E7)', () => {
    expect(markdownToDoc('| a | b |\n|---|---|\n| 1 | 2 |\n\n<div onclick="x()">hi</div>')).toEqual(
      doc(p(text('| a | b | |---|---| | 1 | 2 |')), p(text('<div onclick="x()">hi</div>'))),
    );
  });

  it('turns an external image into a link with its alt text, never an image (E7, E19)', () => {
    expect(
      markdownToDoc('![a cat](https://example.com/cat.png) ![](https://example.com/x.png)'),
    ).toEqual(
      doc(
        p(
          text('a cat', link('https://example.com/cat.png')),
          text(' '),
          text('https://example.com/x.png', link('https://example.com/x.png')),
        ),
      ),
    );
    expect(markdownToDoc('![x](data:image/png;base64,AA==)')).toEqual(doc(p(text('x'))));
  });

  it('lifts images of uploaded files out of their paragraph, and reads file links as chips', () => {
    expect(markdownToDoc(`Before ![shot](${FILE}) after [report.pdf](${FILE})`)).toEqual(
      doc(
        p(text('Before')),
        { type: 'image', attrs: { src: FILE, alt: 'shot' } },
        p(text('after '), { type: 'file', attrs: { src: FILE, name: 'report.pdf' } }),
      ),
    );
  });

  it('keeps the text of links the link rule refuses, without the link', () => {
    expect(
      markdownToDoc('[click](javascript:alert(1)) [rel](/x) [ok](mailto:a@b.co) <https://x.io>'),
    ).toEqual(
      doc(
        p(
          text('click rel '),
          text('ok', link('mailto:a@b.co')),
          text(' '),
          text('https://x.io', link('https://x.io')),
        ),
      ),
    );
  });

  it('reads a bullet list that mixes checklist items as separate lists', () => {
    expect(markdownToDoc('- [ ] a\n- b')).toEqual(
      doc(
        {
          type: 'taskList',
          content: [{ type: 'taskItem', attrs: { checked: false }, content: [p(text('a'))] }],
        },
        { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('b'))] }] },
      ),
    );
  });

  it('starts a list item that opens with another block with an empty paragraph', () => {
    const d = markdownToDoc('- # Title\n- > quote');
    expect(
      d.content?.[0]?.content?.map((item) => item.content?.map((child) => child.type)),
    ).toEqual([
      ['paragraph', 'heading'],
      ['paragraph', 'blockquote'],
    ]);
    expect(roundTrip('- # Title\n- > quote')).toBe('- # Title\n- > quote');
  });

  it('never writes nested empty lists as a thematic break', () => {
    // Found by the fixed-point property: `- - -` reads as `---`.
    expect(roundTrip('+ * *')).toBe('- * -');
    expect(roundTrip(roundTrip('+ * *'))).toBe('- * -');
  });

  it('keeps hard breaks and turns soft breaks into spaces', () => {
    expect(markdownToDoc('one\\\ntwo\nthree')).toEqual(
      doc(p(text('one'), { type: 'hardBreak' }, text('two three'))),
    );
  });
});
