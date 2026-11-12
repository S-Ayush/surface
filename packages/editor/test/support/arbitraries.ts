/**
 * fast-check arbitraries for valid documents (SPEC-013 §4.4): every node, mark and attribute of
 * the schema, headings 1–4 and underline included, with text that is hard to write as Markdown
 * (syntax characters, whitespace, line breaks, NUL, emoji). Shared by the validate and Markdown
 * property tests.
 */
import type { DocMarkJSON, DocNodeJSON } from '@surface/domain';
import fc from 'fast-check';

/** Fixed seed so runs are reproducible; fast-check prints the seed and path of any failure. */
export const PROPERTY_SEED = 20261112;
export const propertyOptions = { seed: PROPERTY_SEED, numRuns: 300 } as const;

const fileId = fc.constantFrom(
  '0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b',
  '0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7c',
  'a3bb189e-8bf9-3888-9912-ace4e6543002',
);
export const fileSrc = fileId.map((id) => `/files/${id}`);

/** Characters that Markdown reads as syntax, whitespace of every kind, and wide characters. */
const TRICKY = [
  ...'abcxyzABZ019 ',
  ...'*_~`[]()<>&#!.-+=|:;\\/"\'{}^$%@?,',
  '\t',
  '\n',
  '\r',
  '\0',
  ' ',
  ' ',
  'é',
  '中',
  '👍',
  '👨‍👩‍👧',
  '&amp;',
  '&#35;',
  '1.',
  '- ',
  '# ',
  '> ',
  '```',
  '***',
  '[ ] ',
  '](',
  '![',
  '<https://x.io>',
];

export const text = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.string({ unit: fc.constantFrom(...TRICKY), minLength: 1, maxLength: 8 }),
  },
  { weight: 1, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 6 }) },
);

export const href = fc.constantFrom(
  'https://example.com',
  'https://example.com/a_(b)?q=1&amp;x',
  'HTTP://EXAMPLE.COM/Path*with*stars',
  'mailto:ada@example.com',
  'https://example.com/<x>\\y',
);

const emphasis = fc.subarray(['bold', 'italic', 'underline', 'strike'] as const);

/** Marks of one text node: code alone, or any other marks with an optional link. */
export const marks: fc.Arbitrary<readonly DocMarkJSON[]> = fc.oneof(
  { weight: 1, arbitrary: fc.constant([{ type: 'code' }]) },
  {
    weight: 6,
    arbitrary: fc
      .tuple(emphasis, fc.option(href, { freq: 3 }))
      .map(([types, link]) => [
        ...(link === null ? [] : [{ type: 'link', attrs: { href: link } }]),
        ...types.map((type) => ({ type })),
      ]),
  },
);

const textNode: fc.Arbitrary<DocNodeJSON> = fc
  .tuple(text, marks)
  .map(([value, m]) =>
    m.length > 0 ? { type: 'text', text: value, marks: m } : { type: 'text', text: value },
  );

const inlineNode: fc.Arbitrary<DocNodeJSON> = fc.oneof(
  { weight: 8, arbitrary: textNode },
  { weight: 1, arbitrary: fc.constant({ type: 'hardBreak' }) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fileSrc, text)
      .map(([src, name]) => ({ type: 'file', attrs: { src, name } })),
  },
);

const inline = fc.array(inlineNode, { maxLength: 6 });

const withContent = (node: DocNodeJSON, content: DocNodeJSON[]): DocNodeJSON =>
  content.length > 0 ? { ...node, content } : node;

const paragraph = inline.map((content) => withContent({ type: 'paragraph' }, content));

const leafBlock: fc.Arbitrary<DocNodeJSON> = fc.oneof(
  { weight: 6, arbitrary: paragraph },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.integer({ min: 1, max: 4 }), inline)
      .map(([level, content]) => withContent({ type: 'heading', attrs: { level } }, content)),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        fc.constantFrom(null, 'js', 'c++', 'objective-c'),
        fc.string({ unit: fc.constantFrom(...'ab `~\n\t\r#> -'), maxLength: 20 }),
      )
      .map(([language, code]) =>
        withContent(
          { type: 'codeBlock', attrs: { language } },
          code === '' ? [] : [{ type: 'text', text: code }],
        ),
      ),
  },
  { weight: 1, arbitrary: fc.constant({ type: 'horizontalRule' }) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fileSrc, fc.option(fc.oneof(text, fc.constant('')), { freq: 2 }))
      .map(([src, alt]) => ({ type: 'image', attrs: { src, alt } })),
  },
);

const { block } = fc.letrec<{ block: DocNodeJSON; blocks: DocNodeJSON[]; item: DocNodeJSON }>(
  (tie) => ({
    block: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      { weight: 6, arbitrary: leafBlock },
      {
        weight: 1,
        arbitrary: tie('blocks').map((content) => ({ type: 'blockquote', content })),
      },
      {
        weight: 2,
        arbitrary: fc
          .tuple(
            fc.constantFrom('bulletList', 'orderedList'),
            fc.array(tie('item'), { minLength: 1, maxLength: 3 }),
          )
          .map(([type, content]) => ({ type, content })),
      },
      {
        weight: 1,
        arbitrary: fc
          .array(
            fc
              .tuple(fc.boolean(), tie('item'))
              .map(([checked, item]) => ({ ...item, type: 'taskItem', attrs: { checked } })),
            { minLength: 1, maxLength: 3 },
          )
          .map((content) => ({ type: 'taskList', content })),
      },
    ),
    blocks: fc.array(tie('block'), { minLength: 1, maxLength: 3 }),
    item: fc
      .tuple(paragraph, fc.array(tie('block'), { maxLength: 2 }))
      .map(([first, rest]) => ({ type: 'listItem', content: [first, ...rest] })),
  }),
);

/** Any valid document. */
export const doc: fc.Arbitrary<DocNodeJSON> = fc
  .array(block, { minLength: 1, maxLength: 5 })
  .map((content) => ({ type: 'doc', content }));

/** Markdown-ish strings: real syntax mixed with text, for the fixed-point property. */
export const markdown: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      fc.constantFrom(
        '# ',
        '##### ',
        '- ',
        '* ',
        '+ ',
        '1. ',
        '3) ',
        '> ',
        '- [ ] ',
        '- [x] ',
        '\n',
        '\n\n',
        '    ',
        '```js\n',
        '```\n',
        '~~~\n',
        '---',
        '***',
        '___',
        '**',
        '*',
        '_',
        '~~',
        '`',
        '\\',
        '\\\n',
        '[a](https://example.com)',
        '[f](/files/0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b)',
        '![i](/files/0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7c)',
        '![x](https://example.com/x.png)',
        '[bad](javascript:alert(1))',
        '<https://example.com>',
        '<b>html</b>',
        '| a | b |\n|---|---|\n',
        '&nbsp;',
        '&amp;',
        '  ',
        '\t',
        '[ref]: https://example.com\n',
      ),
      text,
    ),
    { maxLength: 15 },
  )
  .map((parts) => parts.join(''));
