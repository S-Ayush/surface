/**
 * Comment tables (PLAN-013 S3, SPEC-013 §4.1, §4.2, §4.6).
 *
 * Synced (written only through `sync/repo.ts`): `comments` and `reactions`, the content models
 * `Comment` and `Reaction` (parent `Issue`). Like every synced table, each holds only its model's
 * fields plus `sync_groups`. Server-only: `comment_search_text`, a comment's plain text for search
 * (SPEC-013 D2), written by the comment handlers in the comment's transaction.
 *
 * Every foreign key from `comments` and `reactions` is `ON DELETE RESTRICT`: the handlers delete
 * reactions and replies through the repo, so each deletion gets its `D` delta. A cascade would
 * skip `sync_log` and break sync (SPEC-013 §4.3, architecture rule 2). The one cascade is the
 * server-only search text, which follows its comment.
 *
 * "A reply's parent is a top-level comment" is checked by the handler under the thread lock, not
 * by a trigger (SPEC-013 §4.6).
 */
import { COMMENT_ACTOR_KINDS, type CommentActorKind } from '@surface/domain';
import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { issues } from './issues.js';
import { instant, teams, users } from './workspace.js';

const syncGroups = () => text().array().notNull();

/** `column IN ('a', 'b')` for an enum stored as text. Values are our constants, not input. */
function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
}

export const comments = pgTable(
  'comments',
  {
    id: uuid().primaryKey(),
    issueId: uuid()
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    /** Denormalised: always the issue's team (SPEC-011 §5.1). The repo sets it from the issue row. */
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    /** A top-level comment of the same issue (INV-19, checked by the handler). */
    parentCommentId: uuid(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    actorKind: text().$type<CommentActorKind>().notNull(),
    /** Editor JSON (SPEC-013 §4.4), at most 50 KB (checked by the handler). */
    body: jsonb().notNull(),
    version: integer().notNull().default(1),
    editedAt: instant(),
    deletedAt: instant(),
    resolvedAt: instant(),
    resolvedById: uuid().references(() => users.id, { onDelete: 'restrict' }),
    syncGroups: syncGroups(),
    createdAt: instant().notNull().defaultNow(),
    updatedAt: instant().notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'comments_parent_comment_id_fk',
      columns: [t.parentCommentId],
      foreignColumns: [t.id],
    }).onDelete('restrict'),
    // The issue's timeline, oldest first (SPEC-013 §7), and `comment.list`.
    index('comments_issue_id_created_at_idx').on(t.issueId, t.createdAt),
    // A thread's replies, read under the thread lock (§4.3).
    index('comments_parent_comment_id_idx').on(t.parentCommentId),
    index('comments_sync_groups_idx').using('gin', t.syncGroups),
    check('comments_actor_kind_check', oneOf(t.actorKind, COMMENT_ACTOR_KINDS)),
    check('comments_version_check', sql`${t.version} >= 1`),
    check('comments_resolved_check', sql`(${t.resolvedAt} IS NULL) = (${t.resolvedById} IS NULL)`),
    check(
      'comments_reply_resolved_check',
      sql`${t.parentCommentId} IS NULL OR ${t.resolvedAt} IS NULL`,
    ),
  ],
);

/**
 * A comment's plain text for search (SPEC-013 §4.1, D2): `docToText` of its body. Server-only:
 * never synced, never computed by optimistic code. A soft-deleted comment has no row.
 */
export const commentSearchText = pgTable('comment_search_text', {
  commentId: uuid()
    .primaryKey()
    .references(() => comments.id, { onDelete: 'cascade' }),
  text: text().notNull(),
});

export const reactions = pgTable(
  'reactions',
  {
    /** `reactionId(subject, user, emoji)` (SPEC-013 §4.2): unique per subject, user and emoji. */
    id: uuid().primaryKey(),
    issueId: uuid()
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    /** Null: a reaction on the issue itself (D8). */
    commentId: uuid().references((): AnyPgColumn => comments.id, { onDelete: 'restrict' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    emoji: text().notNull(),
    syncGroups: syncGroups(),
    createdAt: instant().notNull().defaultNow(),
  },
  (t) => [
    index('reactions_comment_id_idx').on(t.commentId),
    index('reactions_issue_id_idx').on(t.issueId),
    index('reactions_sync_groups_idx').using('gin', t.syncGroups),
  ],
);
