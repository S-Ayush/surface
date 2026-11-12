/**
 * `normalize(doc)` (SPEC-013 §4.4): the one form of a document that Markdown can represent, so
 * `markdownToDoc(docToMarkdown(d))` equals `normalize(d)` (AC-8). The rules, in order:
 *
 * - underline marks are removed, and adjacent text with equal marks is merged;
 * - in text (not code), line breaks become spaces and NUL becomes U+FFFD (as markdown-it reads
 *   them); in code blocks, CR and CRLF become LF and NUL becomes U+FFFD;
 * - hard breaks and file chips carry no marks; a hard break in a heading becomes a space;
 * - in paragraphs and headings, whitespace at the start and end is trimmed, whitespace next to
 *   a hard break is removed, and hard breaks at the start and end are removed;
 * - bold, italic or strikethrough that Markdown can't write where it is (CommonMark's flanking
 *   rules: for example `**` can't close after punctuation when a letter follows) is removed from
 *   the character next to the delimiter that fails, until every delimiter works;
 * - an image's empty alt text is null; line breaks in alt text and file names become spaces;
 * - in the document, a block quote and a list item: runs of empty paragraphs collapse to one,
 *   and empty paragraphs at the start and end are removed. A document or block quote left empty
 *   keeps one empty paragraph; a list item always starts with a paragraph (an empty one when its
 *   first block is something else);
 * - adjacent lists of the same kind are merged.
 *
 * The input must be valid (`validateDoc`); the output is valid and in canonical JSON form.
 */
import type { DocNodeJSON } from '@surface/domain';
import type { Delimiter, InlineItem } from './inline.js';
import {
  contentFromItems,
  EMPHASIS,
  itemsFromContent,
  md,
  parseInline,
  sameItem,
  serializeInline,
} from './inline.js';
import { nodeJSON, schema, stringAttr } from './schema.js';

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

/** Text outside code, as markdown-it reads it. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?|\n/g, ' ').replace(/\0/g, '�');
}

function cleanCode(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\0/g, '�');
}

const isWhitespace = (item: InlineItem | undefined): boolean =>
  item?.kind === 'char' && /^\s$/u.test(item.ch);

/** Trim the edges of a text block and the whitespace around its hard breaks. */
function trimItems(items: InlineItem[]): InlineItem[] {
  let result = items;
  let changed = true;
  while (changed) {
    changed = false;
    const next = result.filter((item, i) => {
      const atEdge = i === 0 || i === result.length - 1;
      if (item.kind === 'break' && atEdge) return false;
      if (!isWhitespace(item)) return true;
      if (atEdge) return false;
      return result[i - 1]?.kind !== 'break' && result[i + 1]?.kind !== 'break';
    });
    if (next.length !== result.length) {
      result = next;
      changed = true;
    }
  }
  return result;
}

function withoutMark(item: InlineItem, type: string | null): InlineItem {
  if (item.kind !== 'char') return item;
  return {
    ...item,
    marks: item.marks.filter((mark) =>
      type === null ? !EMPHASIS.has(mark.type) : mark.type !== type,
    ),
  };
}

/**
 * The first emphasis delimiter that markdown-it would not read as opening (or closing) its mark,
 * using markdown-it's own `scanDelims`, so the rule is exactly CommonMark's.
 */
function failingDelimiter(text: string, delimiters: readonly Delimiter[]): Delimiter | null {
  const state = new md.inline.State(text, md, {}, []);
  let i = 0;
  while (i < delimiters.length) {
    const first = delimiters[i];
    if (first === undefined) break;
    // Adjacent delimiters of the same character form one delimiter run.
    const run: Delimiter[] = [first];
    let end = first.start + first.length;
    for (let next = delimiters[i + run.length]; ; next = delimiters[i + run.length]) {
      if (next === undefined || next.start !== end || next.char !== first.char) break;
      run.push(next);
      end += next.length;
    }
    const scan = state.scanDelims(first.start, true);
    for (const delimiter of run) {
      if (delimiter.role === 'open' ? !scan.can_open : !scan.can_close) return delimiter;
    }
    i += run.length;
  }
  return null;
}

/** Remove the emphasis Markdown can't express (the flanking rule above). */
function fixEmphasis(start: InlineItem[], heading: boolean): InlineItem[] {
  let items = start;
  // Each pass removes at least one mark, so this ends; the bound is a safety net.
  for (let pass = 0; pass < 10_000; pass++) {
    const { text, delimiters } = serializeInline(items, { heading });
    const failing = failingDelimiter(text, delimiters);
    if (failing !== null) {
      items = items.map((item, i) =>
        i === failing.index ? withoutMark(item, failing.mark) : item,
      );
      continue;
    }
    const back = parseInline(text, heading ? 'heading' : 'paragraph');
    const mismatch = items.findIndex((item, i) => !sameItem(item, back[i]));
    if (mismatch < 0 && back.length === items.length) return items;
    // Delimiters that each flank correctly can still pair up differently (CommonMark's "rule of
    // 3"). Drop the emphasis where the reading first differs, or everywhere as a last resort.
    const at = mismatch < 0 ? items.length - 1 : mismatch;
    const target = items[at];
    const hasEmphasis = (item: InlineItem | undefined) =>
      item?.kind === 'char' && item.marks.some((mark) => EMPHASIS.has(mark.type));
    if (hasEmphasis(target)) {
      items = items.map((item, i) => (i === at ? withoutMark(item, null) : item));
    } else if (items.some(hasEmphasis)) {
      items = items.map((item) => withoutMark(item, null));
    } else {
      throw new Error('Markdown round trip failed for plain text: an escaping bug.');
    }
  }
  return items;
}

function normalizeInline(content: readonly DocNodeJSON[], heading: boolean): DocNodeJSON[] {
  const cleaned = content.map((node): DocNodeJSON => {
    if (node.type === 'text') return { ...node, text: cleanText(node.text ?? '') };
    if (node.type === 'hardBreak' && heading) return { type: 'text', text: ' ' };
    if (node.type === 'file') {
      const name = cleanText(stringAttr(node, 'name'));
      return { type: 'file', attrs: { src: node.attrs?.['src'], name } };
    }
    return { type: node.type };
  });
  return contentFromItems(fixEmphasis(trimItems(itemsFromContent(cleaned)), heading));
}

function isEmptyParagraph(node: DocNodeJSON | undefined): boolean {
  return node?.type === 'paragraph' && (node.content ?? []).length === 0;
}

function normalizeChildren(
  children: readonly DocNodeJSON[],
  container: 'doc' | 'blockquote' | 'item',
): DocNodeJSON[] {
  const merged: DocNodeJSON[] = [];
  for (const child of children.map(normalizeNode)) {
    const previous = merged.at(-1);
    if (previous !== undefined && previous.type === child.type && LIST_TYPES.has(child.type)) {
      merged[merged.length - 1] = {
        ...previous,
        content: [...(previous.content ?? []), ...(child.content ?? [])],
      };
    } else if (!(isEmptyParagraph(child) && isEmptyParagraph(previous))) {
      merged.push(child);
    }
  }
  while (isEmptyParagraph(merged[0])) merged.shift();
  while (isEmptyParagraph(merged.at(-1))) merged.pop();
  if (container === 'item' ? merged[0]?.type !== 'paragraph' : merged.length === 0) {
    merged.unshift({ type: 'paragraph' });
  }
  return merged;
}

function withContent(node: DocNodeJSON, content: DocNodeJSON[]): DocNodeJSON {
  const { content: _old, ...rest } = node;
  return content.length > 0 ? { ...rest, content } : rest;
}

function normalizeNode(node: DocNodeJSON): DocNodeJSON {
  switch (node.type) {
    case 'doc':
    case 'blockquote':
      return withContent(node, normalizeChildren(node.content ?? [], node.type));
    case 'listItem':
    case 'taskItem':
      return withContent(node, normalizeChildren(node.content ?? [], 'item'));
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return withContent(node, (node.content ?? []).map(normalizeNode));
    case 'paragraph':
      return withContent(node, normalizeInline(node.content ?? [], false));
    case 'heading':
      return withContent(node, normalizeInline(node.content ?? [], true));
    case 'codeBlock': {
      const text = cleanCode((node.content ?? []).map((child) => child.text ?? '').join(''));
      return withContent(node, text === '' ? [] : [{ type: 'text', text }]);
    }
    case 'image': {
      const alt = node.attrs?.['alt'];
      const cleanAlt = typeof alt === 'string' && alt !== '' ? cleanText(alt) : null;
      return { ...node, attrs: { ...node.attrs, alt: cleanAlt } };
    }
    default:
      return node;
  }
}

/** The normalized form of a valid document (see the rules above). Throws on an invalid one. */
export function normalize(doc: DocNodeJSON): DocNodeJSON {
  const canonical = nodeJSON(schema.nodeFromJSON(doc));
  return nodeJSON(schema.nodeFromJSON(normalizeNode(canonical)));
}
