/**
 * The `Draft` model (SPEC-012 §3.2, §4.3; PLAN-012 S5): a user's unsaved issue (one per team, from
 * the composer) or unsent comment (one per issue). Synced only in its owner's `user:<id>` group,
 * so it is user-scoped and declares no `groups` (like `UserPreferences`). It has no refs to Team
 * or Issue on purpose: a draft never resolves its team or issue into anything (permissions.md §2),
 * and the table has no foreign keys to them.
 *
 * The `data` json is checked by the `draft.save` operation with the schemas below; reading it back
 * (`readComposerDraft`, `readCommentDraft`) takes each field on its own, so a draft written by
 * another version keeps what this one understands.
 */
import { z } from 'zod';
import { DOC_MAX_BYTES, docJsonBytes, type DocNodeJSON } from '../doc.js';
import { ISSUE_LABEL_LIMIT } from '../issue.js';
import { defineModel } from './define-model.js';
import { enumOf, json, timestamp, uuid } from './fields.js';

export const DRAFT_KINDS = ['composer', 'comment'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** At most this many comment drafts per user; saving one more deletes the oldest (SPEC-012 §3.2). */
export const COMMENT_DRAFT_LIMIT = 50;

/** The client discards a comment draft older than this when it reads it (SPEC-012 §3.2). */
export const COMMENT_DRAFT_MAX_AGE_DAYS = 30;

/**
 * The raw bound of a draft's title. A draft holds what was typed, so it is the same guard as
 * `issue.create`'s raw title (10,000 characters), not the 255-character rule: that one is checked
 * when the issue is created, with its own message.
 */
export const DRAFT_TITLE_MAX_LENGTH = 10_000;

export const Draft = defineModel('Draft', {
  load: 'eager',
  fields: {
    /** The owner, set by the server from the actor. */
    userId: uuid(),
    kind: enumOf(DRAFT_KINDS),
    /** A composer draft's team (one per user and team); null for a comment draft. */
    teamId: uuid().nullable(),
    /** A comment draft's issue (one per user and issue); null for a composer draft. */
    issueId: uuid().nullable(),
    data: json(),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  },
  indexes: ['userId', 'teamId', 'issueId'],
});

/** A stored editor document (SPEC-013 §4.4), bounded by `max` bytes of JSON. */
function docOf(max: number, what: string) {
  return z
    .object({ type: z.literal('doc') })
    .loose()
    .refine((doc) => docJsonBytes(doc) <= max, {
      message: `The ${what} is too long: at most ${String(max / 1024)} KB.`,
    })
    .transform((doc): DocNodeJSON => doc);
}

/**
 * A composer draft's `data` (SPEC-012 §4.3): what the composer holds. Ids are the user's choices as
 * they were; on restore the ones that no longer resolve are dropped with a note (§3.2).
 */
export const ComposerDraftData = z.strictObject({
  title: z.string().max(DRAFT_TITLE_MAX_LENGTH, 'The title is too long to keep as a draft.'),
  /** SPEC-011 Q9: at most 200 KB of editor JSON. Null while the composer has no description. */
  description: docOf(DOC_MAX_BYTES.description, 'description').nullable(),
  statusId: z.uuid().nullable(),
  priority: z.int().min(0).max(4),
  assigneeId: z.uuid().nullable(),
  labelIds: z.array(z.uuid()).max(ISSUE_LABEL_LIMIT),
  estimate: z.int().nullable(),
  dueDate: z.iso.date().nullable(),
});
export type ComposerDraftData = z.output<typeof ComposerDraftData>;

/** A comment draft's `data`: the comment box's document (SPEC-013 D14: at most 50 KB). */
export const CommentDraftData = z.strictObject({
  text: docOf(DOC_MAX_BYTES.comment, 'comment'),
});
export type CommentDraftData = z.output<typeof CommentDraftData>;

export const EMPTY_COMPOSER_DRAFT: ComposerDraftData = Object.freeze({
  title: '',
  description: null,
  statusId: null,
  priority: 0,
  assigneeId: null,
  labelIds: [],
  estimate: null,
  dueDate: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A composer draft's data as stored, each field read on its own: one that isn't valid (written by
 * another version, or damaged) falls back to its empty value instead of losing the whole draft.
 */
export function readComposerDraft(data: unknown): ComposerDraftData {
  const record = isRecord(data) ? data : {};
  const { shape } = ComposerDraftData;
  const e = EMPTY_COMPOSER_DRAFT;
  return {
    title: field(shape.title, record['title'], e.title),
    description: field(shape.description, record['description'], e.description),
    statusId: field(shape.statusId, record['statusId'], e.statusId),
    priority: field(shape.priority, record['priority'], e.priority),
    assigneeId: field(shape.assigneeId, record['assigneeId'], e.assigneeId),
    labelIds: field(shape.labelIds, record['labelIds'], e.labelIds),
    estimate: field(shape.estimate, record['estimate'], e.estimate),
    dueDate: field(shape.dueDate, record['dueDate'], e.dueDate),
  };
}

function field<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** A comment draft's document, or undefined when the data holds none. */
export function readCommentDraft(data: unknown): DocNodeJSON | undefined {
  const parsed = CommentDraftData.safeParse(data);
  return parsed.success ? parsed.data.text : undefined;
}

/** The plain text of a document's first block that has any, for a one-line preview. */
export function docFirstLine(doc: DocNodeJSON | undefined): string {
  if (doc === undefined) return '';
  for (const block of doc.content ?? []) {
    const text = textOf(block).replace(/\s+/g, ' ').trim();
    if (text !== '') return text;
  }
  return '';
}

function textOf(node: DocNodeJSON): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(textOf).join(node.type === 'paragraph' ? '' : ' ');
}
