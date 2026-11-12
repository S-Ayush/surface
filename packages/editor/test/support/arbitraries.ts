/**
 * fast-check arbitraries for valid documents (SPEC-013 §4.4): every node, mark and attribute of
 * the schema, headings 1–4 and underline included, with text that is hard to write as Markdown
 * (syntax characters, whitespace, line breaks, Unicode punctuation, emoji). Shared by the validate and Markdown
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

/**
 * Characters that Markdown reads as syntax, whitespace of every kind (ASCII, no-break, em and
 * ideographic spaces), Unicode punctuation (which counts for CommonMark's flanking rules) and
 * wide characters. No NUL or lone surrogates: valid documents can't hold them (M2).
 */
const TRICKY = [
  ...'abcxyzABZ019 ',
  ...'*_~`[]()<>&#!.-+=|:;\\/"\'{}^$%@?,',
  '\t',
  '\n',
  '\r',
  '\u00a0',
  '\u2003',
  '\u3000',
  '“',
  '”',
  '—',
  '…',
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

/** Inline content: mostly short, sometimes long enough for many delimiter runs in one line. */
const inline = fc.oneof(
  { weight: 3, arbitrary: fc.array(inlineNode, { maxLength: 6 }) },
  { weight: 1, arbitrary: fc.array(inlineNode, { minLength: 7, maxLength: 16 }) },
);

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

const CONTAINERS = ['blockquote', 'bulletList', 'orderedList', 'taskList'] as const;

/**
 * A paragraph inside a chain of up to 30 block quotes and lists, deeper than markdown-it's
 * default nesting limit of 20 and within `validateDoc`'s 64 levels (M1).
 */
export const deepDoc: fc.Arbitrary<DocNodeJSON> = fc
  .tuple(fc.array(fc.constantFrom(...CONTAINERS), { minLength: 1, maxLength: 30 }), paragraph)
  .map(([chain, inner]) => {
    // doc, paragraph and text take 3 levels; a quote takes 1, a list and its item 2.
    let depth = 3;
    let node = inner;
    for (const kind of chain) {
      const cost = kind === 'blockquote' ? 1 : 2;
      if (depth + cost > 64) break;
      depth += cost;
      if (kind === 'blockquote') node = { type: 'blockquote', content: [node] };
      else {
        const first: DocNodeJSON = { type: 'paragraph', content: [{ type: 'text', text: 'x' }] };
        const item: DocNodeJSON =
          kind === 'taskList'
            ? { type: 'taskItem', attrs: { checked: false }, content: [first, node] }
            : { type: 'listItem', content: [first, node] };
        node = { type: kind, content: [item] };
      }
    }
    return { type: 'doc', content: [node] };
  });

const WORD_CHARS = [...'abcXYZ019', '\u00e9', '\u4e2d'];
const word = fc.string({ unit: fc.constantFrom(...WORD_CHARS), minLength: 1, maxLength: 4 });

type Group =
  string | { readonly mark: string; readonly children: readonly Group[]; readonly gap: string };

const { group } = fc.letrec<{ group: Group }>((tie) => ({
  group: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    { weight: 2, arbitrary: word },
    {
      weight: 1,
      arbitrary: fc.record({
        mark: fc.constantFrom('bold', 'italic', 'strike'),
        // A word first and last: a run never starts or ends together with a run inside it.
        children: fc
          .tuple(word, fc.array(tie('group'), { maxLength: 2 }), word)
          .map(([first, middle, last]) => [first, ...middle, last]),
        gap: fc.constantFrom(' ', ''),
      }),
    },
  ),
}));

/** Two groups side by side get a space: their delimiters would merge into one run. */
const gapBetween = (before: Group | undefined, after: Group, gap: string): string =>
  gap === '' && typeof before === 'object' && typeof after === 'object' ? ' ' : gap;

function flatten(node: Group, marks: readonly string[], out: DocNodeJSON[]): void {
  const textOf = (value: string, on: readonly string[]): DocNodeJSON =>
    on.length > 0
      ? { type: 'text', text: value, marks: on.map((type) => ({ type })) }
      : { type: 'text', text: value };
  if (typeof node === 'string') {
    out.push(textOf(node, marks));
    return;
  }
  const inner = marks.includes(node.mark) ? marks : [...marks, node.mark];
  node.children.forEach((child, i) => {
    const gap = gapBetween(node.children[i - 1], child, node.gap);
    if (i > 0 && gap !== '') out.push(textOf(gap, inner));
    flatten(child, inner, out);
  });
}

/**
 * A paragraph of words where bold, italic and strikethrough nest properly, every run starts and
 * ends on a letter or digit, and each delimiter is next to a letter, a digit, a space or the edge
 * of the block: emphasis Markdown can always write (M3). Not included, because CommonMark can't
 * write them:
 * - a run that starts or ends at the same character as a run inside it, within a word (`a` +
 *   bold-and-struck `b` + struck `c`): the inner delimiter counts as punctuation for the outer
 *   one's flanking rule;
 * - two runs that touch (`**a a**` then `*b*`): their delimiters merge into `***`, and the "rule
 *   of 3" can pair them differently.
 */
export const nestedEmphasis: fc.Arbitrary<DocNodeJSON> = fc
  .tuple(fc.array(group, { minLength: 1, maxLength: 6 }), fc.constantFrom(' ', ''))
  .map(([groups, gap]) => {
    const content: DocNodeJSON[] = [];
    groups.forEach((g, i) => {
      const between = gapBetween(groups[i - 1], g, gap);
      if (i > 0 && between !== '') content.push({ type: 'text', text: between });
      flatten(g, [], content);
    });
    return { type: 'doc', content: [{ type: 'paragraph', content }] };
  });

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
