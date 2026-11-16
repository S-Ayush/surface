// What the comment timeline shows, as plain data (SPEC-013 §3.1–§3.4, §7). Pure: the components read
// the replica and hand rows here, so the grouping, the resolved line and the reaction chips are
// tested without a DOM.
import { EMPTY_DOC, summariseReactions, type DocNodeJSON } from '@surface/domain';
import { Comment, Reaction, type ModelRow, type RowOfModel } from '@surface/domain/model';
import type { ReactionChipData } from '@surface/ui';

/** A comment row with its body as a document (the model stores it as JSON). */
export type CommentRow = Omit<RowOfModel<typeof Comment>, 'body'> & { readonly body: DocNodeJSON };
export type ReactionRow = RowOfModel<typeof Reaction>;

/** A thread: a top-level comment and its replies, oldest first (SPEC-013 §3.2, INV-19). */
export interface Thread {
  readonly root: CommentRow;
  readonly replies: readonly CommentRow[];
  /** `resolvedAt` of the root (§3.3a): the thread shows as one line until expanded. */
  readonly resolved: boolean;
}

const byAge = (a: CommentRow, b: CommentRow) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Parses the content rows the replica holds; a row that doesn't match the model is left out. */
export function commentRows(rows: readonly ModelRow[] | undefined): CommentRow[] {
  const out: CommentRow[] = [];
  for (const row of rows ?? []) {
    const parsed = Comment.rowSchema.safeParse(row);
    if (parsed.success) out.push({ ...parsed.data, body: docOf(parsed.data.body) });
  }
  return out;
}

/** The stored body as a document; anything else shows as empty rather than crashing (§4.4). */
function docOf(value: unknown): DocNodeJSON {
  return isDoc(value) ? value : EMPTY_DOC;
}

export function isDoc(value: unknown): value is DocNodeJSON {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'doc';
}

export function reactionRows(rows: readonly ModelRow[] | undefined): ReactionRow[] {
  const out: ReactionRow[] = [];
  for (const row of rows ?? []) {
    const parsed = Reaction.rowSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * The threads of an issue, oldest first. A reply whose root isn't held (it is hard-deleted only
 * with its last reply, §4.3, so this is a sync race) is shown as a thread of its own rather than
 * lost.
 */
export function buildThreads(comments: readonly CommentRow[]): Thread[] {
  const ids = new Set(comments.map((comment) => comment.id));
  const roots = comments
    .filter((c) => c.parentCommentId === null || !ids.has(c.parentCommentId))
    .sort(byAge);
  return roots.map((root) => ({
    root,
    replies: comments.filter((c) => c.parentCommentId === root.id).sort(byAge),
    resolved: root.resolvedAt !== null,
  }));
}

/** The first line of a document's text, for the resolved thread's one line (§3.3a). */
export function firstLineOf(doc: DocNodeJSON): string {
  const parts: string[] = [];
  const walk = (node: DocNodeJSON): boolean => {
    if (node.text !== undefined) parts.push(node.text);
    for (const child of node.content ?? []) {
      if (walk(child)) return true;
    }
    // A block ends the line, so the first non-empty block is the line.
    return node.type !== 'doc' && node.type !== 'text' && parts.join('').trim() !== '';
  };
  walk(doc);
  return parts.join('').trim().replace(/\s+/g, ' ');
}

/** Whether a document has text, an image or a file: an empty comment can't be sent (§3.1 item 3). */
export function hasContent(doc: DocNodeJSON | null | undefined): boolean {
  if (doc === null || doc === undefined) return false;
  if (doc.type === 'image' || doc.type === 'file') return true;
  if (doc.text !== undefined && doc.text.trim() !== '') return true;
  return (doc.content ?? []).some((child) => hasContent(child));
}

/** The document with the checklist item at `path` set (§4.4: the host's author rule decides who). */
export function withChecked(
  doc: DocNodeJSON,
  path: readonly number[],
  checked: boolean,
): DocNodeJSON {
  const [index, ...rest] = path;
  if (index === undefined) {
    return { ...doc, attrs: { ...(doc.attrs ?? {}), checked } };
  }
  const content = doc.content;
  const child = content?.[index];
  if (content === undefined || child === undefined) return doc;
  return {
    ...doc,
    content: content.map((node, i) => (i === index ? withChecked(child, rest, checked) : node)),
  };
}

/** Whether two documents are the same JSON, for the edit box's Save and the dirty-close guard. */
export function sameDoc(a: DocNodeJSON, b: DocNodeJSON): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- Reactions ---------------------------------------------------------------------------------

/** The rows of one subject: a comment's, or the issue's own (`commentId` null). */
export function reactionsOf(
  rows: readonly ReactionRow[],
  commentId: string | null,
): readonly ReactionRow[] {
  return rows.filter((row) => row.commentId === commentId);
}

/** What `ReactionChips` shows for a subject: the chips with emoji names and who reacted. */
export function reactionChips(
  rows: readonly ReactionRow[],
  me: string | null,
  userName: (id: string) => string,
  emojiName: (emoji: string) => string | undefined,
): ReactionChipData[] {
  return summariseReactions(rows, me).map((chip) => {
    const names = rows
      .filter((row) => row.emoji === chip.emoji)
      .map((row) => (row.userId === me ? 'You' : userName(row.userId)))
      // "You" first (SPEC-013 §3.4), the rest in the order they reacted.
      .sort((a, b) => Number(b === 'You') - Number(a === 'You'));
    const label = emojiName(chip.emoji);
    return { ...chip, ...(label === undefined ? {} : { label }), people: names };
  });
}

// ---- Links -------------------------------------------------------------------------------------

/** The element id a comment link scrolls to (§7). */
export const commentDomId = (id: string) => `comment-${id}`;

/** `/issue/ENG-42#comment-<id>`, with the page's own origin (§7). */
export function commentLink(origin: string, identifier: string, commentId: string): string {
  return `${origin.replace(/\/+$/, '')}/issue/${identifier}#${commentDomId(commentId)}`;
}

/** The comment id a location hash names, or undefined (§7). */
export function commentIdOfHash(hash: string): string | undefined {
  const match = /^#?comment-([0-9a-f-]{36})$/i.exec(hash);
  return match?.[1]?.toLowerCase();
}

// ---- Time --------------------------------------------------------------------------------------

const longRelative = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'long' });
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3 hours ago", for a comment's accessible name (§7); a date past a week. */
export function agoLong(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const ago = now.getTime() - at.getTime();
  if (ago < 2 * MINUTE) return 'just now';
  if (ago < HOUR) return longRelative.format(-Math.floor(ago / MINUTE), 'minute');
  if (ago < DAY) return longRelative.format(-Math.floor(ago / HOUR), 'hour');
  if (ago < 7 * DAY) return longRelative.format(-Math.floor(ago / DAY), 'day');
  return at.toLocaleDateString('en', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** The absolute time for a tooltip (§7). */
export function absoluteTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ''
    : at.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
}
