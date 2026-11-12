/**
 * Inline content as a flat list of items, and its Markdown form (SPEC-013 §4.4 "Markdown"). Shared
 * by `normalize` (which must know what Markdown can express) and `markdown.ts` (which writes and
 * reads it), so both use one serializer and one parser.
 *
 * Markdown is CommonMark plus GFM strikethrough and task lists, read by markdown-it. Delimiters:
 * `**` bold, `*` italic, `~~` strikethrough, backticks for code, `[text](href)` for links and
 * `[name](/files/<uuid>)` for file chips. Text is escaped so that nothing in it reads as syntax.
 */
import type { DocMarkJSON, DocNodeJSON } from '@surface/domain';
import MarkdownIt from 'markdown-it';
import type { StateCore, Token } from 'markdown-it';
import { fileIdOfSrc, isAllowedHref } from './links.js';
import { stringAttr } from './schema.js';

// ---------------------------------------------------------------------------------------------
// The markdown-it instance

/** `- [ ] text` / `- [x] text` at the start of a bullet item's first paragraph (GFM task lists). */
const TASK_PREFIX = /^\[([ xX])\](?:[ \t\n]+|$)/;

/**
 * A core rule, run after block parsing and before inline parsing: marks bullet items that start
 * with a checkbox as task items (`meta.task`, `meta.checked`) and strips the checkbox from the
 * paragraph source. markdown-it has no task lists of its own; this is the "small rule" of
 * SPEC-013 §4.4.
 */
function taskItems(state: StateCore): void {
  const tokens = state.tokens;
  const lists: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      lists.push(token.type);
    } else if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') {
      lists.pop();
    } else if (token.type === 'list_item_open' && lists.at(-1) === 'bullet_list_open') {
      const paragraph = tokens[i + 1];
      const inline = tokens[i + 2];
      if (paragraph?.type !== 'paragraph_open' || inline?.type !== 'inline') continue;
      const match = TASK_PREFIX.exec(inline.content);
      if (match === null) continue;
      inline.content = inline.content.slice(match[0].length);
      token.meta = { task: true, checked: match[1] !== ' ' };
    }
  }
}

function createMarkdownIt() {
  // Raw HTML is text (never markup), bare URLs stay text, quotes stay as typed.
  const md = new MarkdownIt('commonmark', { html: false, linkify: false, typographer: false });
  md.enable('strikethrough');
  // Links are checked by the link rule and stored exactly as written: no percent-encoding.
  md.normalizeLink = (url) => url;
  md.normalizeLinkText = (text) => text;
  md.validateLink = () => true;
  md.core.ruler.after('block', 'surface_task_items', taskItems);
  return md;
}

export const md = createMarkdownIt();

// ---------------------------------------------------------------------------------------------
// Items

export interface CharItem {
  readonly kind: 'char';
  /** One code point. */
  readonly ch: string;
  /** Marks in schema order, never underline (Markdown has none). */
  readonly marks: readonly DocMarkJSON[];
}
export interface BreakItem {
  readonly kind: 'break';
}
export interface FileItem {
  readonly kind: 'file';
  readonly src: string;
  readonly name: string;
}
export type InlineItem = CharItem | BreakItem | FileItem;

/** Marks Markdown writes with delimiter runs (CommonMark flanking rules apply to them). */
export const EMPHASIS = new Set(['bold', 'italic', 'strike']);
/** Schema order of the marks Markdown can express. */
const MARK_RANK: Record<string, number> = { link: 0, bold: 1, italic: 2, strike: 3, code: 4 };

export function markRank(type: string): number {
  return MARK_RANK[type] ?? 99;
}

export function sameMark(a: DocMarkJSON, b: DocMarkJSON): boolean {
  return a.type === b.type && (a.type !== 'link' || a.attrs?.['href'] === b.attrs?.['href']);
}

function hasMark(marks: readonly DocMarkJSON[], mark: DocMarkJSON): boolean {
  return marks.some((other) => sameMark(other, mark));
}

function hasType(marks: readonly DocMarkJSON[], type: string): boolean {
  return marks.some((mark) => mark.type === type);
}

export function sameItem(a: InlinePiece | undefined, b: InlinePiece | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === 'char' && b.kind === 'char') {
    return (
      a.ch === b.ch &&
      a.marks.length === b.marks.length &&
      a.marks.every((mark) => hasMark(b.marks, mark))
    );
  }
  if (a.kind === 'file' && b.kind === 'file') return a.src === b.src && a.name === b.name;
  if (a.kind === 'image' && b.kind === 'image') return a.src === b.src && a.alt === b.alt;
  return a.kind === 'break' && b.kind === 'break';
}

function sortMarks(marks: readonly DocMarkJSON[]): DocMarkJSON[] {
  return [...marks].sort((a, b) => markRank(a.type) - markRank(b.type));
}

/** Inline JSON content (text, hardBreak, file) as items. Underline and unknown marks drop. */
export function itemsFromContent(content: readonly DocNodeJSON[]): InlineItem[] {
  const items: InlineItem[] = [];
  for (const node of content) {
    if (node.type === 'text') {
      const marks = sortMarks(
        (node.marks ?? []).filter((mark) => Object.hasOwn(MARK_RANK, mark.type)),
      );
      for (const ch of node.text ?? '') items.push({ kind: 'char', ch, marks });
    } else if (node.type === 'hardBreak') {
      items.push({ kind: 'break' });
    } else if (node.type === 'file') {
      items.push({
        kind: 'file',
        src: stringAttr(node, 'src'),
        name: stringAttr(node, 'name'),
      });
    }
  }
  return items;
}

/** Items back to inline JSON content; adjacent characters with equal marks share a text node. */
export function contentFromItems(items: readonly InlineItem[]): DocNodeJSON[] {
  const content: DocNodeJSON[] = [];
  let text = '';
  let marks: readonly DocMarkJSON[] = [];
  const flush = () => {
    if (text === '') return;
    content.push(marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text });
    text = '';
  };
  for (const item of items) {
    if (item.kind === 'char') {
      const same =
        item.marks.length === marks.length && item.marks.every((mark) => hasMark(marks, mark));
      if (!same) {
        flush();
        marks = item.marks;
      }
      text += item.ch;
      continue;
    }
    flush();
    content.push(
      item.kind === 'break'
        ? { type: 'hardBreak' }
        : { type: 'file', attrs: { src: item.src, name: item.name } },
    );
  }
  flush();
  return content;
}

// ---------------------------------------------------------------------------------------------
// Serializing

/** One emphasis delimiter written by the serializer, for the flanking check in `normalize`. */
export interface Delimiter {
  readonly start: number;
  readonly char: '*' | '~';
  readonly length: number;
  readonly role: 'open' | 'close';
  readonly mark: string;
  /** The item next to the delimiter on the inside of the mark. */
  readonly index: number;
}

export interface SerializedInline {
  readonly text: string;
  readonly delimiters: readonly Delimiter[];
}

const ALWAYS_ESCAPED = new Set(['\\', '`', '*', '_', '~', '[', ']', '<']);
const ESCAPED_AT_LINE_START = new Set(['#', '>', '-', '+', '=']);
const ENTITY_AHEAD = /^#?[A-Za-z0-9]+;/;

/** Text of a link label or image alt: no line starts, so only the always-escaped characters. */
export function escapeLabel(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ALWAYS_ESCAPED.has(ch) || (ch === '&' && ENTITY_AHEAD.test(text.slice(i + 1)))) {
      out += '\\';
    }
    out += ch;
  }
  return out;
}

/** A link destination: backslash-escape what markdown-it would read as syntax or an entity. */
export function escapeDestination(href: string): string {
  return href.replace(/[\\()<>]|&(?=#?[A-Za-z0-9]+;)/g, (ch) => `\\${ch}`);
}

const DELIMITER: Record<string, string> = { bold: '**', italic: '*', strike: '~~' };

/** A code span whose fence is longer or shorter than every backtick run inside it. */
export function codeSpan(code: string): string {
  const runs = new Set(Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  let fence = 1;
  while (runs.has(fence)) fence++;
  const ticks = '`'.repeat(fence);
  const pad =
    code.startsWith('`') ||
    code.endsWith('`') ||
    (code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code));
  return pad ? `${ticks} ${code} ${ticks}` : `${ticks}${code}${ticks}`;
}

/**
 * Markdown for inline items. In `heading` mode every `#` is escaped (a trailing one would close
 * the heading). Marks open longest-first, so a mark that outlasts another nests outside it.
 */
export function serializeInline(
  items: readonly InlineItem[],
  options: { readonly heading?: boolean } = {},
): SerializedInline {
  let out = '';
  let lineStart = 0;
  let bareBang = false;
  const delimiters: Delimiter[] = [];
  const stack: DocMarkJSON[] = [];

  const emit = (text: string) => {
    out += text;
    const newline = text.lastIndexOf('\n');
    if (newline >= 0) lineStart = out.length - text.length + newline + 1;
    bareBang = false;
  };
  const emitBracket = () => {
    // `![` would start an image.
    if (bareBang) out = `${out.slice(0, -1)}\\!`;
    emit('[');
  };
  const runEnd = (mark: DocMarkJSON, from: number): number => {
    let end = from;
    while (true) {
      const next = items[end + 1];
      if (next?.kind !== 'char' || !hasMark(next.marks, mark)) return end;
      end++;
    }
  };
  const open = (mark: DocMarkJSON, index: number) => {
    stack.push(mark);
    if (mark.type === 'link') {
      emitBracket();
      return;
    }
    const delimiter = DELIMITER[mark.type] ?? '';
    delimiters.push({
      start: out.length,
      char: delimiter === '~~' ? '~' : '*',
      length: delimiter.length,
      role: 'open',
      mark: mark.type,
      index,
    });
    emit(delimiter);
  };
  const close = (index: number) => {
    const mark = stack.pop();
    if (mark === undefined) return;
    if (mark.type === 'link') {
      emit(
        `](${escapeDestination(typeof mark.attrs?.['href'] === 'string' ? mark.attrs['href'] : '')})`,
      );
      return;
    }
    const delimiter = DELIMITER[mark.type] ?? '';
    delimiters.push({
      start: out.length,
      char: delimiter === '~~' ? '~' : '*',
      length: delimiter.length,
      role: 'close',
      mark: mark.type,
      index,
    });
    emit(delimiter);
  };
  const emitChar = (ch: string, ahead: () => string) => {
    const line = out.slice(lineStart);
    let escape = ALWAYS_ESCAPED.has(ch);
    if (ch === '&') escape = ENTITY_AHEAD.test(ahead());
    else if (ch === '#') escape = options.heading === true || line === '';
    else if (ESCAPED_AT_LINE_START.has(ch)) escape = line === '';
    else if (ch === '.' || ch === ')') escape = /^\d+$/.test(line);
    emit(escape ? `\\${ch}` : ch);
    bareBang = ch === '!';
  };

  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (item === undefined) break;
    if (item.kind === 'char' && hasType(item.marks, 'code')) {
      while (stack.length > 0) close(i - 1);
      let code = '';
      while (i < items.length) {
        const next = items[i];
        if (next?.kind !== 'char' || !hasType(next.marks, 'code')) break;
        code += next.ch;
        i++;
      }
      emit(codeSpan(code));
      continue;
    }
    const wanted = item.kind === 'char' ? item.marks : [];
    const firstStale = stack.findIndex((mark) => !hasMark(wanted, mark));
    if (firstStale >= 0) while (stack.length > firstStale) close(i - 1);
    const toOpen = wanted
      .filter((mark) => !hasMark(stack, mark))
      .map((mark) => ({ mark, end: runEnd(mark, i) }))
      .sort((a, b) => b.end - a.end || markRank(a.mark.type) - markRank(b.mark.type));
    for (const { mark } of toOpen) open(mark, i);

    if (item.kind === 'char') {
      emitChar(item.ch, () => {
        let ahead = '';
        for (let j = i + 1; j < items.length && ahead.length < 40; j++) {
          const next = items[j];
          if (next?.kind !== 'char') break;
          ahead += next.ch;
        }
        return ahead;
      });
    } else if (item.kind === 'break') {
      emit('\\\n');
    } else {
      emitBracket();
      emit(`${escapeLabel(item.name)}](${item.src})`);
    }
    i++;
  }
  while (stack.length > 0) close(items.length - 1);
  return { text: out, delimiters };
}

// ---------------------------------------------------------------------------------------------
// Parsing

/** An image found in inline Markdown; `paragraph` mode lifts `/files/` images to blocks. */
export interface ImagePiece {
  readonly kind: 'image';
  readonly src: string;
  readonly alt: string | null;
}
export type InlinePiece = InlineItem | ImagePiece;

/** Plain text of inline tokens: an image's alt text, a file chip's name. */
export function plainText(tokens: readonly Token[] | null): string {
  let text = '';
  for (const token of tokens ?? []) {
    if (token.type === 'softbreak' || token.type === 'hardbreak') text += ' ';
    else if (token.type === 'image') text += plainText(token.children);
    else if (token.type === 'text' || token.type === 'code_inline' || token.type === 'html_inline')
      text += token.content;
  }
  return text;
}

const TOKEN_MARK: Record<string, string> = {
  strong_open: 'bold',
  strong_close: 'bold',
  em_open: 'italic',
  em_close: 'italic',
  s_open: 'strike',
  s_close: 'strike',
};

/**
 * Inline tokens to pieces. In `paragraph` mode an image of an uploaded file becomes an image
 * piece (the caller lifts it to a block); elsewhere, and inside links, images become their alt
 * text. An image of anything else becomes a link with its alt text (SPEC-013 §4.4, E7, E19).
 */
export function piecesFromTokens(
  tokens: readonly Token[],
  mode: 'paragraph' | 'heading',
): InlinePiece[] {
  const pieces: InlinePiece[] = [];
  // `null` entries are links that failed the link rule: their text stays, unlinked.
  const stack: (DocMarkJSON | null)[] = [];
  let file: { src: string; name: string; depth: number } | null = null;

  const currentMarks = (): DocMarkJSON[] => {
    const marks: DocMarkJSON[] = [];
    for (const mark of stack) {
      if (mark === null) continue;
      const existing = marks.findIndex((other) => other.type === mark.type);
      if (existing >= 0) marks.splice(existing, 1);
      marks.push(mark);
    }
    return sortMarks(marks);
  };
  const pushText = (text: string, marks: DocMarkJSON[]) => {
    for (const ch of text) pieces.push({ kind: 'char', ch, marks });
  };
  const insideLink = () => stack.some((mark) => mark?.type === 'link');

  for (const token of tokens) {
    if (file !== null) {
      if (token.type === 'link_open') file.depth++;
      else if (token.type === 'link_close' && --file.depth === 0) {
        pieces.push({ kind: 'file', src: file.src, name: file.name === '' ? 'File' : file.name });
        file = null;
      } else file.name += plainText([token]);
      continue;
    }
    const markType = TOKEN_MARK[token.type];
    if (markType !== undefined) {
      if (token.nesting === 1) stack.push({ type: markType });
      else stack.pop();
      continue;
    }
    switch (token.type) {
      case 'text':
      case 'html_inline':
        pushText(token.content, currentMarks());
        break;
      case 'softbreak':
        pushText(' ', currentMarks());
        break;
      case 'hardbreak':
        pieces.push({ kind: 'break' });
        break;
      case 'code_inline':
        pushText(token.content, [{ type: 'code' }]);
        break;
      case 'link_open': {
        const href = String(token.attrGet('href') ?? '');
        if (fileIdOfSrc(href) !== null) file = { src: href, name: '', depth: 1 };
        else stack.push(isAllowedHref(href) ? { type: 'link', attrs: { href } } : null);
        break;
      }
      case 'link_close':
        stack.pop();
        break;
      case 'image': {
        const src = String(token.attrGet('src') ?? '');
        const alt = plainText(token.children);
        if (fileIdOfSrc(src) !== null && mode === 'paragraph' && !insideLink()) {
          pieces.push({ kind: 'image', src, alt: alt === '' ? null : alt });
        } else if (fileIdOfSrc(src) === null && isAllowedHref(src) && !insideLink()) {
          pushText(alt === '' ? src : alt, sortMarks([...currentMarks(), linkMark(src)]));
        } else {
          pushText(alt, currentMarks());
        }
        break;
      }
      default:
        if (token.content !== '') pushText(token.content, currentMarks());
    }
  }
  return pieces;
}

function linkMark(href: string): DocMarkJSON {
  return { type: 'link', attrs: { href } };
}

/** Parse one line of inline Markdown (no block syntax) to items. */
export function parseInline(text: string, mode: 'paragraph' | 'heading'): InlinePiece[] {
  const inline = md.parseInline(text, {})[0];
  return piecesFromTokens(inline?.children ?? [], mode);
}
