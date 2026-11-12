/**
 * Markdown ↔ document (SPEC-013 §4.4 "Markdown"; SPEC-011 Q12, D20): the API and MCP take and
 * return Markdown, and "Copy content as Markdown" uses `docToMarkdown`.
 *
 * `docToMarkdown` writes the normalized document, and `markdownToDoc` normalizes what it reads,
 * so `markdownToDoc(docToMarkdown(d))` equals `normalize(d)` and one pass reaches a fixed point
 * (AC-8). Choices that make that hold: blocks are separated by blank lines; an empty paragraph
 * is written `&nbsp;`; bullet lists use `-` and switch to `*` when they follow another bullet
 * list or checklist (so the two stay apart); a thematic break is `___` (`- ---` would read as a
 * break, not a list item); code blocks are always fenced.
 *
 * Reading: CommonMark plus GFM strikethrough and task lists. Headings 5 and 6 become heading 4.
 * Tables and raw HTML stay as plain text (E7). An image of an uploaded file becomes an image
 * block; any other image becomes a link with its alt text, or plain text when the link rule
 * refuses it. A link to `/files/<uuid>` becomes a file chip; other links follow the link rule.
 */
import type { DocNodeJSON } from '@surface/domain';
import type { Token } from 'markdown-it';
import type { InlineItem } from './inline.js';
import {
  contentFromItems,
  escapeLabel,
  itemsFromContent,
  md,
  piecesFromTokens,
  serializeInline,
} from './inline.js';
import { normalize } from './normalize.js';

// ---------------------------------------------------------------------------------------------
// Writing

/**
 * Markers a list must not use: the one of a list right before it (the two would merge) or of the
 * list item it hangs on (`- - -` would read as a thematic break).
 */
interface Avoid {
  readonly bullet?: string;
  readonly delimiter?: string;
}

const bulletFor = (avoid: Avoid) => (avoid.bullet === '-' ? '*' : '-');
const delimiterFor = (avoid: Avoid) => (avoid.delimiter === '.' ? ')' : '.');

function indent(text: string, width: number): string {
  const pad = ' '.repeat(width);
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : pad + line))
    .join('\n');
}

function inlineMarkdown(node: DocNodeJSON, heading: boolean): string {
  return serializeInline(itemsFromContent(node.content ?? []), { heading }).text;
}

function codeFence(code: string): string {
  const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The first line of `rest` goes after `marker`; the other lines are indented under it. */
function hang(marker: string, rest: string): string {
  const [first = '', ...others] = rest.split('\n');
  const body = indent(others.join('\n'), marker.length);
  const head = first === '' ? marker.trimEnd() : marker + first;
  return others.length > 0 ? `${head}\n${body}` : head;
}

function listItem(item: DocNodeJSON, marker: string, task: boolean): string {
  const children = item.content ?? [];
  const [first, ...rest] = children;
  const head = first === undefined ? '' : inlineMarkdown(first, false);
  if (task) {
    const box = item.attrs?.['checked'] === true ? '[x]' : '[ ]';
    const line = hang(`${marker}${box} `, head);
    // The checkbox keeps the first line a paragraph, so the other blocks follow a blank line.
    return rest.length === 0 ? line : `${line}\n\n${indent(blocks(rest), marker.length)}`;
  }
  if (head === '' && rest.length > 0) {
    // `-` alone followed by a blank line would end the item, so the next block hangs on the
    // marker line (`- # Heading`, `- - nested`). normalize() ensures it isn't a paragraph.
    const [second, ...more] = rest;
    const host = marker.startsWith('-') || marker.startsWith('*') ? { bullet: marker[0] } : {};
    const hung = hang(marker, block(second ?? { type: 'paragraph' }, host));
    return more.length === 0 ? hung : `${hung}\n\n${indent(blocks(more), marker.length)}`;
  }
  const line = hang(marker, head);
  return rest.length === 0 ? line : `${line}\n\n${indent(blocks(rest), marker.length)}`;
}

function list(node: DocNodeJSON, avoid: Avoid): string {
  const items = node.content ?? [];
  if (node.type === 'orderedList') {
    const delimiter = delimiterFor(avoid);
    return items.map((item, i) => listItem(item, `${i + 1}${delimiter} `, false)).join('\n');
  }
  const bullet = `${bulletFor(avoid)} `;
  return items.map((item) => listItem(item, bullet, node.type === 'taskList')).join('\n');
}

function block(node: DocNodeJSON, avoid: Avoid): string {
  switch (node.type) {
    case 'paragraph': {
      const text = inlineMarkdown(node, false);
      return text === '' ? '&nbsp;' : text;
    }
    case 'heading': {
      const level = Number(node.attrs?.['level'] ?? 1);
      const text = inlineMarkdown(node, true);
      return text === '' ? '#'.repeat(level) : `${'#'.repeat(level)} ${text}`;
    }
    case 'blockquote':
      return blocks(node.content ?? [])
        .split('\n')
        .map((line) => (line === '' ? '>' : `> ${line}`))
        .join('\n');
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return list(node, avoid);
    case 'codeBlock': {
      const code = (node.content ?? []).map((child) => child.text ?? '').join('');
      const fence = codeFence(code);
      const language = node.attrs?.['language'];
      return `${fence}${typeof language === 'string' ? language : ''}\n${code}\n${fence}`;
    }
    case 'horizontalRule':
      return '___';
    case 'image': {
      const alt = node.attrs?.['alt'];
      return `![${typeof alt === 'string' ? escapeLabel(alt) : ''}](${String(node.attrs?.['src'])})`;
    }
    default:
      return '';
  }
}

function blocks(nodes: readonly DocNodeJSON[]): string {
  let avoid: Avoid = {};
  return nodes
    .map((node) => {
      const text = block(node, avoid);
      if (node.type === 'orderedList') avoid = { delimiter: delimiterFor(avoid) };
      else if (node.type === 'bulletList' || node.type === 'taskList') {
        avoid = { bullet: bulletFor(avoid) };
      } else avoid = {};
      return text;
    })
    .join('\n\n');
}

/** Markdown for a valid document. Underline is dropped (CommonMark has none; AC-25). */
export function docToMarkdown(doc: DocNodeJSON): string {
  const normalized = normalize(doc);
  const content = normalized.content ?? [];
  // The empty document is the empty string, not `&nbsp;`.
  if (content.length === 1 && (content[0]?.content ?? []).length === 0) {
    if (content[0]?.type === 'paragraph') return '';
  }
  return blocks(content);
}

// ---------------------------------------------------------------------------------------------
// Reading

class Reader {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  /** Blocks until a token of type `until` (consumed) or the end. */
  blocks(until: string | null): DocNodeJSON[] {
    const nodes: DocNodeJSON[] = [];
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index++];
      if (token === undefined || token.type === until) break;
      nodes.push(...this.block(token));
    }
    return nodes;
  }

  private inline(): Token[] {
    const token = this.tokens[this.index];
    if (token?.type !== 'inline') return [];
    this.index++;
    return token.children ?? [];
  }

  private skip(type: string): void {
    if (this.tokens[this.index]?.type === type) this.index++;
  }

  private block(token: Token): DocNodeJSON[] {
    switch (token.type) {
      case 'paragraph_open': {
        const children = this.inline();
        this.skip('paragraph_close');
        return paragraphs(children);
      }
      case 'heading_open': {
        const level = Math.min(4, Number(token.tag.slice(1)) || 1);
        const content = contentFromItems(inlineItems(this.inline(), 'heading'));
        this.skip('heading_close');
        return [withContent({ type: 'heading', attrs: { level } }, content)];
      }
      case 'blockquote_open':
        return [{ type: 'blockquote', content: filled(this.blocks('blockquote_close')) }];
      case 'bullet_list_open':
        return this.bulletList();
      case 'ordered_list_open':
        return [{ type: 'orderedList', content: this.items('ordered_list_close') }];
      case 'fence':
      case 'code_block':
        return [codeBlock(token)];
      case 'hr':
        return [{ type: 'horizontalRule' }];
      // No `html_block`: markdown-it runs with `html: false`, so raw HTML is paragraph text.
      default:
        return [];
    }
  }

  private items(close: string): DocNodeJSON[] {
    const items: DocNodeJSON[] = [];
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index++];
      if (token === undefined || token.type === close) break;
      if (token.type !== 'list_item_open') continue;
      const content = itemContent(this.blocks('list_item_close'));
      const task = token.meta?.['task'] === true;
      items.push(
        task
          ? { type: 'taskItem', attrs: { checked: token.meta?.['checked'] === true }, content }
          : { type: 'listItem', content },
      );
    }
    return items;
  }

  /** A bullet list whose items are partly checklist items splits into runs of each kind. */
  private bulletList(): DocNodeJSON[] {
    const lists: DocNodeJSON[] = [];
    for (const item of this.items('bullet_list_close')) {
      const type = item.type === 'taskItem' ? 'taskList' : 'bulletList';
      const last = lists.at(-1);
      if (last?.type === type)
        lists[lists.length - 1] = { type, content: [...(last.content ?? []), item] };
      else lists.push({ type, content: [item] });
    }
    return lists;
  }
}

function withContent(node: DocNodeJSON, content: DocNodeJSON[]): DocNodeJSON {
  return content.length > 0 ? { ...node, content } : node;
}

function filled(content: DocNodeJSON[]): DocNodeJSON[] {
  return content.length > 0 ? content : [{ type: 'paragraph' }];
}

function itemContent(content: DocNodeJSON[]): DocNodeJSON[] {
  return content[0]?.type === 'paragraph' ? content : [{ type: 'paragraph' }, ...content];
}

const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,40}$/;

function codeBlock(token: Token): DocNodeJSON {
  // markdown-it keeps the newline that ends the last line.
  const code = token.content.endsWith('\n') ? token.content.slice(0, -1) : token.content;
  const word = token.info.trim().split(/\s+/)[0] ?? '';
  const language = LANGUAGE.test(word) ? word : null;
  return withContent(
    { type: 'codeBlock', attrs: { language } },
    code === '' ? [] : [{ type: 'text', text: code }],
  );
}

function inlineItems(tokens: readonly Token[], mode: 'paragraph' | 'heading'): InlineItem[] {
  const items: InlineItem[] = [];
  for (const piece of piecesFromTokens(tokens, mode)) if (piece.kind !== 'image') items.push(piece);
  return items;
}

/** A paragraph, split around the images of uploaded files, which are blocks. */
function paragraphs(tokens: readonly Token[]): DocNodeJSON[] {
  const pieces = piecesFromTokens(tokens, 'paragraph');
  if (!pieces.some((piece) => piece.kind === 'image')) {
    return [withContent({ type: 'paragraph' }, contentFromItems(inlineItems(tokens, 'paragraph')))];
  }
  const nodes: DocNodeJSON[] = [];
  let run: InlineItem[] = [];
  const flush = () => {
    // Only whitespace and breaks between two images: no paragraph.
    if (run.some((item) => item.kind === 'file' || (item.kind === 'char' && /\S/u.test(item.ch)))) {
      nodes.push({ type: 'paragraph', content: contentFromItems(run) });
    }
    run = [];
  };
  for (const piece of pieces) {
    if (piece.kind === 'image') {
      flush();
      nodes.push({ type: 'image', attrs: { src: piece.src, alt: piece.alt } });
    } else {
      run.push(piece);
    }
  }
  flush();
  return nodes;
}

/** A document from Markdown, normalized. Never fails: what it can't map stays as text. */
export function markdownToDoc(markdown: string): DocNodeJSON {
  const tokens = md.parse(markdown, {});
  const content = filled(new Reader(tokens).blocks(null));
  return normalize({ type: 'doc', content });
}
