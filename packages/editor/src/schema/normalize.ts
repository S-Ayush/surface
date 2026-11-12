/**
 * `normalize(doc)` (SPEC-013 §4.4): the one form of a document that Markdown can represent, so
 * `markdownToDoc(docToMarkdown(d))` equals `normalize(d)` (AC-8). The rules, in order:
 *
 * - underline marks are removed, and adjacent text with equal marks is merged;
 * - in text, line breaks (CR, LF, CRLF) become spaces, as markdown-it reads them; in code blocks,
 *   CR and CRLF become LF;
 * - hard breaks and file chips carry no marks; a hard break in a heading becomes a space;
 * - in paragraphs and headings, spaces and tabs at the start of a line after a hard break are
 *   removed (Markdown drops them; a no-break space stays), then whitespace and hard breaks at the
 *   start and end of the block. Whitespace inside inline code is never removed;
 * - bold, italic or strikethrough that Markdown can't write where it is (CommonMark's flanking
 *   rules: for example `**` can't close after punctuation when a letter follows) is removed from
 *   the character next to each delimiter that fails, all of them in one pass, until every
 *   delimiter works and the block reads back the same. A block that still doesn't after
 *   `MAX_EMPHASIS_PASSES` passes loses all its bold, italic and strikethrough. Each pass is
 *   linear in the block, so normalizing is linear in the document (PLAN-013 S1 review, B1);
 * - an image's empty alt text is null; line breaks in alt text and file names become spaces;
 * - in the document, a block quote and a list item: runs of empty paragraphs collapse to one,
 *   and empty paragraphs at the start and end are removed. A document or block quote left empty
 *   keeps one empty paragraph; a list item always starts with a paragraph (an empty one when its
 *   first block is something else);
 * - adjacent lists of the same kind are merged.
 *
 * `normalize` validates first and throws on an invalid document. The output is valid and in
 * canonical JSON form.
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
import { validateDoc } from './validate.js';

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

/** Passes of the emphasis repair per block, the last one stripping and checking (B1). */
export const MAX_EMPHASIS_PASSES = 8;

/** For tests: the most passes one block has taken since `max` was last reset. */
export const EMPHASIS_PASSES = { max: 0 };

/** Text outside code blocks, as markdown-it reads it (it also turns NUL into U+FFFD). */
function cleanText(text: string): string {
  return text.replace(/\r\n?|\n/g, ' ');
}

function cleanCode(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

const isCode = (item: InlineItem): boolean =>
  item.kind === 'char' && item.marks.some((mark) => mark.type === 'code');

/** A space or tab that Markdown drops at the start of a line. */
const isLineSpace = (item: InlineItem): boolean =>
  item.kind === 'char' && (item.ch === ' ' || item.ch === '\t') && !isCode(item);

/** What markdown-it trims at the edges of a block (JavaScript's `trim`), and hard breaks. */
const isEdge = (item: InlineItem | undefined): boolean =>
  item !== undefined &&
  (item.kind === 'break' || (item.kind === 'char' && /^\s$/u.test(item.ch) && !isCode(item)));

/** Drop spaces and tabs that start a line, then trim the edges of the block. Linear. */
function trimItems(items: readonly InlineItem[]): InlineItem[] {
  const kept: InlineItem[] = [];
  let lineStart = false;
  for (const item of items) {
    if (lineStart && isLineSpace(item)) continue;
    lineStart = item.kind === 'break';
    kept.push(item);
  }
  let start = 0;
  let end = kept.length;
  while (start < end && isEdge(kept[start])) start++;
  while (end > start && isEdge(kept[end - 1])) end--;
  return kept.slice(start, end);
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

const hasEmphasis = (item: InlineItem | undefined): boolean =>
  item?.kind === 'char' && item.marks.some((mark) => EMPHASIS.has(mark.type));

/**
 * Every emphasis delimiter that markdown-it would not read as opening (or closing) its mark,
 * using markdown-it's own `scanDelims`, so the rule is exactly CommonMark's.
 */
function failingDelimiters(text: string, delimiters: readonly Delimiter[]): Delimiter[] {
  const state = new md.inline.State(text, md, {}, []);
  const failing: Delimiter[] = [];
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
      if (delimiter.role === 'open' ? !scan.can_open : !scan.can_close) failing.push(delimiter);
    }
    i += run.length;
  }
  return failing;
}

/** Indexes where the block reads back differently, or null when it reads back the same. */
function mismatches(items: readonly InlineItem[], text: string, heading: boolean): number[] | null {
  const back = parseInline(text, heading ? 'heading' : 'paragraph');
  if (back.length === items.length) {
    const differ = items.flatMap((item, i) => (sameItem(item, back[i]) ? [] : [i]));
    return differ.length > 0 ? differ : null;
  }
  // Delimiters left over as text shift everything after them: only the first difference counts.
  const first = items.findIndex((item, i) => !sameItem(item, back[i]));
  return [first < 0 ? items.length - 1 : first];
}

function countPass(pass: number): void {
  EMPHASIS_PASSES.max = Math.max(EMPHASIS_PASSES.max, pass);
}

/** Remove the emphasis Markdown can't express (the flanking rule above), in bounded passes. */
function fixEmphasis(start: InlineItem[], heading: boolean): InlineItem[] {
  let items = start;
  for (let pass = 1; pass < MAX_EMPHASIS_PASSES; pass++) {
    countPass(pass);
    const { text, delimiters } = serializeInline(items, { heading });
    const failing = failingDelimiters(text, delimiters);
    if (failing.length > 0) {
      const drop = new Map<number, (string | null)[]>();
      for (const { index, mark } of failing) drop.set(index, [...(drop.get(index) ?? []), mark]);
      items = items.map((item, i) =>
        (drop.get(i) ?? []).reduce<InlineItem>((out, mark) => withoutMark(out, mark), item),
      );
      continue;
    }
    const differ = mismatches(items, text, heading);
    if (differ === null) return items;
    // Delimiters that each flank correctly can still pair up differently (CommonMark's "rule of
    // 3"). Drop the emphasis where the reading differs; if none is there, strip the block below.
    const targets = new Set(differ.filter((i) => hasEmphasis(items[i])));
    if (targets.size === 0) break;
    items = items.map((item, i) => (targets.has(i) ? withoutMark(item, null) : item));
  }
  // The last pass: no bold, italic or strikethrough at all, which always reads back the same.
  countPass(MAX_EMPHASIS_PASSES);
  const plain = items.map((item) => withoutMark(item, null));
  if (mismatches(plain, serializeInline(plain, { heading }).text, heading) !== null) {
    throw new Error('Markdown round trip failed without emphasis: an escaping bug.');
  }
  return plain;
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

/**
 * The normalized form of a document our Markdown reader built: its shape follows the schema and
 * the link, file and language rules by construction, so only ProseMirror's content check runs.
 * It may still be too deep or too long; `markdownToDoc`'s caller validates the result.
 */
export function normalizeShape(doc: DocNodeJSON): DocNodeJSON {
  const canonical = nodeJSON(schema.nodeFromJSON(doc));
  return nodeJSON(schema.nodeFromJSON(normalizeNode(canonical)));
}

/** The normalized form of a valid document (the rules above). Throws on an invalid one. */
export function normalize(doc: DocNodeJSON): DocNodeJSON {
  const valid = validateDoc(doc);
  if (!valid.ok) {
    const [first] = valid.problems;
    const where = JSON.stringify(first?.path ?? []);
    throw new TypeError(`normalize needs a valid document: ${first?.message ?? ''} (at ${where})`);
  }
  return normalizeShape(valid.doc);
}
