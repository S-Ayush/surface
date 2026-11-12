/**
 * The explicit extension list of the document schema (SPEC-013 §4.4). This list *is* the stored
 * document format: the headless entry builds its schema from it, and the web entry (PLAN-013 S2)
 * extends these same extensions with keys and input rules, swapping in a lowlight `codeBlock`
 * under the same name and attributes. Only `@tiptap/core` is used here (no StarterKit), so no
 * extension can add a node, mark or attribute that isn't listed (`editor-schema-headless` in
 * `.dependency-cruiser.cjs`). Changing anything here changes the schema: bump
 * `DOC_SCHEMA_VERSION` and ship a document migration (SPEC-013 D6, ADR-0023).
 *
 * `parseHTML` and `renderHTML` follow TipTap's own extensions, so pasted HTML maps as users
 * expect; the headless entry never calls them.
 */
import { Mark, mergeAttributes, Node } from '@tiptap/core';
import { fileIdOfSrc, isAllowedHref } from './links.js';

export const Document = Node.create({
  name: 'doc',
  topNode: true,
  content: 'block+',
});

export const Text = Node.create({
  name: 'text',
  group: 'inline',
});

export const Paragraph = Node.create({
  name: 'paragraph',
  priority: 1000,
  group: 'block',
  content: 'inline*',
  parseHTML: () => [{ tag: 'p' }],
  renderHTML: ({ HTMLAttributes }) => ['p', HTMLAttributes, 0],
});

export const HEADING_LEVELS = [1, 2, 3, 4] as const;

export const Heading = Node.create({
  name: 'heading',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes: () => ({ level: { default: 1, rendered: false } }),
  parseHTML: () => HEADING_LEVELS.map((level) => ({ tag: `h${level}`, attrs: { level } })),
  renderHTML: ({ node, HTMLAttributes }) => [`h${String(node.attrs['level'])}`, HTMLAttributes, 0],
});

export const Blockquote = Node.create({
  name: 'blockquote',
  group: 'block',
  content: 'block+',
  defining: true,
  parseHTML: () => [{ tag: 'blockquote' }],
  renderHTML: ({ HTMLAttributes }) => ['blockquote', HTMLAttributes, 0],
});

export const BulletList = Node.create({
  name: 'bulletList',
  group: 'block list',
  content: 'listItem+',
  parseHTML: () => [{ tag: 'ul' }],
  renderHTML: ({ HTMLAttributes }) => ['ul', HTMLAttributes, 0],
});

export const OrderedList = Node.create({
  name: 'orderedList',
  group: 'block list',
  content: 'listItem+',
  parseHTML: () => [{ tag: 'ol' }],
  renderHTML: ({ HTMLAttributes }) => ['ol', HTMLAttributes, 0],
});

export const ListItem = Node.create({
  name: 'listItem',
  content: 'paragraph block*',
  defining: true,
  parseHTML: () => [{ tag: 'li' }],
  renderHTML: ({ HTMLAttributes }) => ['li', HTMLAttributes, 0],
});

export const TaskList = Node.create({
  name: 'taskList',
  group: 'block list',
  content: 'taskItem+',
  // Higher than BulletList, so `ul[data-type="taskList"]` wins over `ul`.
  priority: 200,
  parseHTML: () => [{ tag: 'ul[data-type="taskList"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'ul',
    mergeAttributes(HTMLAttributes, { 'data-type': 'taskList' }),
    0,
  ],
});

export const TaskItem = Node.create({
  name: 'taskItem',
  content: 'paragraph block*',
  defining: true,
  priority: 200,
  addAttributes: () => ({
    checked: {
      default: false,
      keepOnSplit: false,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-checked') === 'true',
      renderHTML: (attributes: Record<string, unknown>) => ({
        'data-checked': attributes['checked'] === true ? 'true' : 'false',
      }),
    },
  }),
  parseHTML: () => [{ tag: 'li[data-type="taskItem"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'li',
    mergeAttributes(HTMLAttributes, { 'data-type': 'taskItem' }),
    0,
  ],
});

export const CodeBlock = Node.create({
  name: 'codeBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  addAttributes: () => ({
    language: {
      default: null,
      rendered: false,
      parseHTML: (element: HTMLElement) => {
        const name = /language-(\S+)/.exec(element.firstElementChild?.className ?? '')?.[1];
        return name ?? null;
      },
    },
  }),
  parseHTML: () => [{ tag: 'pre', preserveWhitespace: 'full' }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const language: unknown = node.attrs['language'];
    return [
      'pre',
      HTMLAttributes,
      ['code', typeof language === 'string' ? { class: `language-${language}` } : {}, 0],
    ];
  },
});

export const HorizontalRule = Node.create({
  name: 'horizontalRule',
  group: 'block',
  parseHTML: () => [{ tag: 'hr' }],
  renderHTML: ({ HTMLAttributes }) => ['hr', HTMLAttributes],
});

export const HardBreak = Node.create({
  name: 'hardBreak',
  inline: true,
  group: 'inline',
  selectable: false,
  linebreakReplacement: true,
  parseHTML: () => [{ tag: 'br' }],
  renderHTML: ({ HTMLAttributes }) => ['br', HTMLAttributes],
  renderText: () => '\n',
});

/** A raster image, shown inline as its own block. `src` is always `/files/<uuid>` (SPEC-014). */
export const Image = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ src: { default: null }, alt: { default: null } }),
  parseHTML: () => [
    {
      tag: 'img[src]',
      getAttrs: (element: HTMLElement) =>
        fileIdOfSrc(element.getAttribute('src') ?? '') === null ? false : null,
    },
  ],
  renderHTML: ({ HTMLAttributes }) => ['img', HTMLAttributes],
});

/** An uploaded file shown as a chip with its name (SPEC-014 §4.3). */
export const File = Node.create({
  name: 'file',
  inline: true,
  group: 'inline',
  atom: true,
  addAttributes: () => ({
    src: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute('href') },
    name: { default: null, parseHTML: (element: HTMLElement) => element.textContent },
  }),
  parseHTML: () => [
    {
      tag: 'a[data-type="file"]',
      getAttrs: (element: HTMLElement) =>
        fileIdOfSrc(element.getAttribute('href') ?? '') === null ? false : null,
    },
  ],
  renderHTML: ({ node }) => [
    'a',
    { 'data-type': 'file', href: node.attrs['src'] as string },
    String(node.attrs['name']),
  ],
  renderText: ({ node }) => String(node.attrs['name']),
});

/** Links follow the link rule; `rel` and `target` are rendered, never stored (SPEC-013 §4.4). */
export const Link = Mark.create({
  name: 'link',
  priority: 1000,
  inclusive: false,
  addAttributes: () => ({ href: { default: null } }),
  parseHTML: () => [
    {
      tag: 'a[href]',
      getAttrs: (element: HTMLElement) =>
        isAllowedHref(element.getAttribute('href') ?? '') ? null : false,
    },
  ],
  renderHTML: ({ HTMLAttributes }) => [
    'a',
    mergeAttributes(HTMLAttributes, { rel: 'noopener noreferrer nofollow', target: '_blank' }),
    0,
  ],
});

export const Bold = Mark.create({
  name: 'bold',
  parseHTML: () => [{ tag: 'strong' }, { tag: 'b' }],
  renderHTML: ({ HTMLAttributes }) => ['strong', HTMLAttributes, 0],
});

export const Italic = Mark.create({
  name: 'italic',
  parseHTML: () => [{ tag: 'em' }, { tag: 'i' }],
  renderHTML: ({ HTMLAttributes }) => ['em', HTMLAttributes, 0],
});

export const Underline = Mark.create({
  name: 'underline',
  parseHTML: () => [{ tag: 'u' }],
  renderHTML: ({ HTMLAttributes }) => ['u', HTMLAttributes, 0],
});

export const Strike = Mark.create({
  name: 'strike',
  parseHTML: () => [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }],
  renderHTML: ({ HTMLAttributes }) => ['s', HTMLAttributes, 0],
});

/** Inline code excludes every other mark (SPEC-013 §4.4). */
export const Code = Mark.create({
  name: 'code',
  excludes: '_',
  code: true,
  parseHTML: () => [{ tag: 'code' }],
  renderHTML: ({ HTMLAttributes }) => ['code', HTMLAttributes, 0],
});

/** Every extension of the schema, in order. Nothing else may add to the schema. */
export const SCHEMA_EXTENSIONS = [
  Document,
  Paragraph,
  Text,
  Heading,
  Blockquote,
  BulletList,
  OrderedList,
  ListItem,
  TaskList,
  TaskItem,
  CodeBlock,
  HorizontalRule,
  HardBreak,
  Image,
  File,
  Link,
  Bold,
  Italic,
  Underline,
  Strike,
  Code,
] as const;
